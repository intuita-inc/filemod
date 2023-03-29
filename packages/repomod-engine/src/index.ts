import * as platformPath from 'node:path';
import { ExternalFileCommand } from './externalFileCommands';
import { FacadeFileSystem } from './files';
import { stat } from 'node:fs/promises';

type Options = Readonly<Record<string, string | undefined>>;

export interface UpsertFileCommand {
	readonly kind: 'upsertFile';
	readonly path: string;
	readonly options: Options;
}

export interface DeleteFileCommand {
	readonly kind: 'deleteFile';
	readonly path: string;
}

export interface MoveFileCommand {
	readonly kind: 'moveFile';
	readonly oldPath: string;
	readonly newPath: string;
	readonly options: Options;
}

export interface CopyFileCommand {
	readonly kind: 'copyFile';
	readonly oldPath: string;
	readonly newPath: string;
	readonly options: Options;
}

export type FileCommand =
	| UpsertFileCommand
	| DeleteFileCommand
	| MoveFileCommand
	| CopyFileCommand;

export interface HandleDirectoryCommand {
	readonly kind: 'handleDirectory';
	readonly path: string;
	readonly options: Options;
}

export interface HandleFileCommand {
	readonly kind: 'handleFile';
	readonly path: string;
	readonly options: Options;
}

export type DirectoryCommand = HandleDirectoryCommand | HandleFileCommand;

export interface UpsertDataCommand {
	readonly kind: 'upsertData';
	readonly data: string;
	readonly path: string; // TODO we can remove it and add from context at a later stageW
}

export interface NoopCommand {
	readonly kind: 'noop';
}

export type DataCommand = UpsertDataCommand | NoopCommand;

export type Command = DirectoryCommand | FileCommand | DataCommand;

export interface PathAPI {
	readonly getDirname: (path: string) => string; // might throw
	readonly getBasename: (path: string) => string; // might throw
	readonly joinPaths: (...paths: string[]) => string; // might throw
}

interface DataAPI extends PathAPI {
	getDependencies: () => Record<string, unknown>;
}

interface FileAPI extends PathAPI, DataAPI {
	readonly isDirectory: (path: string) => boolean;
	readonly exists: (path: string) => boolean;
	// reading directories and files
	readonly readFile: (filePath: string) => Promise<string>;
}

interface DirectoryAPI extends FileAPI {
	readonly readDirectory: (
		directoryPath: string,
	) => Promise<readonly string[]>; // might throw
}

export interface Repomod {
	readonly includePatterns?: readonly string[];
	readonly excludePatterns?: readonly string[];
	readonly handleDirectory?: (
		api: DirectoryAPI,
		path: string,
		options: Options,
	) => Promise<readonly DirectoryCommand[]>;
	readonly handleFile?: (
		api: FileAPI,
		path: string,
		options: Options,
	) => Promise<readonly FileCommand[]>;
	readonly handleData?: (
		api: DataAPI,
		path: string,
		data: string,
		options: Options,
	) => Promise<DataCommand>;
}

export interface API {
	facadeFileSystem: FacadeFileSystem;
	directoryAPI: DirectoryAPI;
	fileAPI: FileAPI;
	dataAPI: DataAPI;
}

const defaultHandleDirectory: Repomod['handleDirectory'] = async (
	api,
	directoryPath,
	options,
) => {
	const commands: DirectoryCommand[] = [];

	const paths = await api.readDirectory(directoryPath);

	for (const path of paths) {
		const directory = api.isDirectory(path);

		if (directory) {
			commands.push({
				kind: 'handleDirectory',
				path,
				options,
			});
		} else {
			commands.push({
				kind: 'handleFile',
				path,
				options,
			});
		}
	}

	return commands;
};

const defaultHandleFile: Repomod['handleFile'] = async (_, path, options) =>
	Promise.resolve([
		{
			kind: 'upsertFile',
			path,
			options,
		},
	]);

const defaultHandleData: Repomod['handleData'] = async () =>
	Promise.resolve({
		kind: 'noop',
	});

const handleCommand = async (
	api: API,
	repomod: Repomod,
	command: Command,
): Promise<void> => {
	if (command.kind === 'handleDirectory') {
		if (repomod.includePatterns) {
			const paths = await api.facadeFileSystem.getFilePaths(
				command.path,
				repomod.includePatterns,
				repomod.excludePatterns ?? [],
			);

			for (const path of paths) {
				const handleFileCommand: HandleFileCommand = {
					kind: 'handleFile',
					path,
					options: command.options,
				};

				await handleCommand(api, repomod, handleFileCommand);
			}
		}

		const facadeEntry = await api.facadeFileSystem.upsertFacadeDirectory(
			command.path,
		);

		if (facadeEntry === null) {
			return;
		}

		const handleDirectory =
			repomod.handleDirectory ?? defaultHandleDirectory;

		const commands = await handleDirectory(
			api.directoryAPI,
			command.path,
			command.options,
		);

		for (const command of commands) {
			await handleCommand(api, repomod, command);
		}
	}

	if (command.kind === 'handleFile') {
		const facadeEntry = await api.facadeFileSystem.upsertFacadeFile(
			command.path,
		);

		if (facadeEntry === null) {
			return;
		}

		const handleFile = repomod.handleFile ?? defaultHandleFile;

		const commands = await handleFile(
			api.fileAPI,
			command.path,
			command.options,
		);

		for (const command of commands) {
			await handleCommand(api, repomod, command);
		}
	}

	if (command.kind === 'upsertFile') {
		const data = await api.facadeFileSystem.readFile(command.path);

		const handleData = repomod.handleData ?? defaultHandleData;

		const dataCommand = await handleData(
			api.dataAPI,
			command.path,
			data,
			command.options,
		);

		await handleCommand(api, repomod, dataCommand);
	}

	if (command.kind === 'deleteFile') {
		api.facadeFileSystem.deleteFile(command.path);
	}

	if (command.kind === 'upsertData') {
		api.facadeFileSystem.upsertData(command.path, command.data);
	}
};

export const buildApi = (
	facadeFileSystem: FacadeFileSystem,
	getDependencies: DataAPI['getDependencies'],
): API => {
	const pathAPI: PathAPI = {
		getDirname: (path) => platformPath.dirname(path),
		getBasename: (path) => platformPath.basename(path),
		joinPaths: (...paths) => platformPath.join(...paths),
	};

	const dataAPI: DataAPI = {
		getDependencies,
		...pathAPI,
	};

	const directoryAPI: DirectoryAPI = {
		readDirectory: (path) => facadeFileSystem.readDirectory(path),
		isDirectory: (path) => facadeFileSystem.isDirectory(path),
		exists: (path) => facadeFileSystem.exists(path),
		readFile: (path) => facadeFileSystem.readFile(path),
		...dataAPI,
	};

	const fileAPI: FileAPI = {
		...directoryAPI,
	};

	return {
		directoryAPI,
		facadeFileSystem,
		fileAPI,
		dataAPI,
	};
};

export const executeRepomod = async (
	api: API,
	repomod: Repomod,
	path: string,
	options: Options,
): Promise<readonly ExternalFileCommand[]> => {
	const facadeEntry = await api.facadeFileSystem.upsertFacadeEntry(path);

	if (facadeEntry === null) {
		return [];
	}

	const command: DirectoryCommand = {
		kind:
			facadeEntry.kind === 'directory' ? 'handleDirectory' : 'handleFile',
		path,
		options,
	};

	await handleCommand(api, repomod, command);

	return api.facadeFileSystem.buildExternalFileCommands();
};

// tests

const repomod: Repomod = {
	includePatterns: ['**/*.index.html'],
	handleFile: async (api, path: string, options) => {
		console.log('HF', api.getBasename(path));

		// we process only index.html files here (in this mod)
		if (api.getBasename(path) !== 'index.html') {
			return []; // no commands
		}

		const index_html_path = path;

		const dirname = api.getDirname(index_html_path);
		const document_tsx_path = api.joinPaths(dirname, 'Document.tsx');

		if (!api.exists(document_tsx_path)) {
			return [];
		}

		// this operation will call the file system and cache the file content
		const index_html_data = await api.readFile(path);

		return [
			{
				// here, we mark the index.html file for deletion
				// if another function reads it, this would end up in an error
				// the file will be really deleted only after the mod has finished
				kind: 'deleteFile',
				path: index_html_path,
				options,
			},
			{
				// let's handle the data
				kind: 'upsertFile',
				path: document_tsx_path,
				options: {
					...options,
					index_html_data,
				},
			},
		];
	},
	// this function might not be called at all
	handleData: async (_, path, __, options) => {
		const index_html_data = options['index_html_data'] ?? '';

		return Promise.resolve({
			kind: 'upsertData',
			path,
			data: index_html_data,
		});
	},
};

import { Volume } from 'memfs';
import { FileSystemManager } from './fileSystemManager';

const vol = Volume.fromJSON({});

vol.mkdirSync('/test');
vol.mkdirSync('/a/b/c', { recursive: true });
vol.writeFileSync('/test/index.html', 'aaa', {});
vol.writeFileSync('/test/Document.tsx', 'bbb', {});
vol.writeFileSync('/a/b/c/Document.tsx', 'bbb', {});
vol.writeFileSync('/a/b/c/index.html', 'bbb', {});

const fileSystemManager = new FileSystemManager(stat);

const ffs = new FacadeFileSystem(vol as any, fileSystemManager);
const api = buildApi(ffs, () => ({}));

executeRepomod(api, repomod, '/', {})
	.then((x) => {
		console.log(x);
	})
	.catch((err) => {
		console.error(err);
	});
