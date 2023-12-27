import { LeftRightHashSetManager } from './leftRightHashSetManager.js';
import type { ExternalFileCommand } from './externalFileCommands.js';

interface UnifiedFile {
	readonly kind: 'file';
	readonly path: string;
}

interface UnifiedDirectory {
	readonly kind: 'directory';
	readonly path: string;
}

type UnifiedEntry = UnifiedFile | UnifiedDirectory;
export type PathHashDigest = string & {
	__PathHashDigest: '__PathHashDigest';
};

export interface GlobArguments {
	readonly includePatterns: ReadonlyArray<string>;
	readonly excludePatterns: ReadonlyArray<string>;
	readonly absolute: true;
	readonly currentWorkingDirectory: string;
}

export class UnifiedFileSystem {
	private __directoryFiles = new LeftRightHashSetManager<
		PathHashDigest,
		PathHashDigest
	>(new Set());
	private __entries = new Map<PathHashDigest, UnifiedEntry>();
	private __changes = new Map<PathHashDigest, string | null>();

	public constructor(
		private __glob: (
			globArguments: GlobArguments,
		) => Promise<ReadonlyArray<string>>,
		private __getUnifiedEntry: (path: string) => Promise<UnifiedEntry>,
		private __readDirectory: (
			path: string,
		) => Promise<ReadonlyArray<UnifiedEntry>>,
		private __readFile: (path: string) => Promise<string>,
		private __buildPathHashDigest: (path: string) => PathHashDigest,
	) {}

	public async upsertUnifiedEntry(
		path: string,
	): Promise<UnifiedEntry | null> {
		const unifiedDirectory = await this.upsertUnifiedDirectory(path);

		if (unifiedDirectory) {
			return unifiedDirectory;
		}

		return this.upsertUnifiedFile(path);
	}

	public async upsertUnifiedDirectory(
		directoryPath: string,
	): Promise<UnifiedEntry | null> {
		const directoryPathHashDigest =
			this.__buildPathHashDigest(directoryPath);

		if (!this.__entries.has(directoryPathHashDigest)) {
			const unifiedEntry = await this.__getUnifiedEntry(directoryPath);

			if (unifiedEntry.kind !== 'directory') {
				return null;
			}

			this.__entries.set(directoryPathHashDigest, unifiedEntry);

			return unifiedEntry;
		}

		return this.__entries.get(directoryPathHashDigest) ?? null;
	}

	public async upsertUnifiedFile(
		filePath: string,
	): Promise<UnifiedEntry | null> {
		const filePathHashDigest = this.__buildPathHashDigest(filePath);

		if (!this.__entries.has(filePathHashDigest)) {
			const unifiedEntry = await this.__getUnifiedEntry(filePath);

			if (unifiedEntry.kind !== 'file') {
				return null;
			}

			this.__entries.set(filePathHashDigest, unifiedEntry);

			return unifiedEntry;
		}

		return this.__entries.get(filePathHashDigest) ?? null;
	}

	public async readDirectory(
		directoryPath: string,
	): Promise<readonly string[]> {
		const directoryPathHashDigest =
			this.__buildPathHashDigest(directoryPath);

		const unifiedEntries = await this.__readDirectory(directoryPath);

		unifiedEntries.forEach((unifiedEntry) => {
			const pathHashDigest = this.__buildPathHashDigest(
				unifiedEntry.path,
			);

			if (unifiedEntry.kind === 'directory') {
				// TODO check if it's not removed

				this.__directoryFiles.upsert(
					directoryPathHashDigest,
					pathHashDigest,
				);
				this.__entries.set(pathHashDigest, unifiedEntry);
			}

			if (unifiedEntry.kind === 'file') {
				// TODO check if it's not removed

				this.__directoryFiles.upsert(
					directoryPathHashDigest,
					pathHashDigest,
				);
				this.__entries.set(pathHashDigest, unifiedEntry);
			}
		});

		const paths: string[] = [];

		this.__directoryFiles
			.getRightHashesByLeftHash(directoryPathHashDigest)
			.forEach((pathHashDigest) => {
				const unifiedEntry = this.__entries.get(pathHashDigest);

				if (unifiedEntry !== undefined) {
					paths.push(unifiedEntry.path);
				}
			});

		return paths;
	}

	public async readFile(path: string): Promise<string> {
		const pathHashDigest = this.__buildPathHashDigest(path);

		const upsertedData = this.__changes.get(pathHashDigest);

		if (upsertedData === undefined) {
			try {
				return await this.__readFile(path);
			} catch (error) {
				return '';
			}
		}

		if (upsertedData === null) {
			throw new Error('This file has already been deleted');
		}

		return upsertedData;
	}

	public isDirectory(directoryPath: string): boolean {
		const directoryPathHashDigest =
			this.__buildPathHashDigest(directoryPath);

		return (
			this.__entries.get(directoryPathHashDigest)?.kind === 'directory'
		);
	}

	public exists(directoryPath: string): boolean {
		const directoryPathHashDigest =
			this.__buildPathHashDigest(directoryPath);

		return this.__entries.has(directoryPathHashDigest);
	}

	public async getFilePaths(
		directoryPath: string,
		includePatterns: readonly string[],
		excludePatterns: readonly string[],
	): Promise<readonly string[]> {
		const paths = await this.__glob({
			includePatterns: includePatterns.slice(),
			excludePatterns: excludePatterns.slice(),
			currentWorkingDirectory: directoryPath,
			absolute: true,
		});

		paths.forEach((path) => {
			const unifiedFile: UnifiedFile = {
				kind: 'file',
				path,
			};

			const pathHashDigest = this.__buildPathHashDigest(path);

			this.__entries.set(pathHashDigest, unifiedFile);
		});

		return paths;
	}

	public deleteFile(filePath: string): void {
		const pathHashDigest = this.__buildPathHashDigest(filePath);

		const unifiedFile: UnifiedFile = {
			kind: 'file',
			path: filePath,
		};

		this.__entries.set(pathHashDigest, unifiedFile);
		this.__changes.set(pathHashDigest, null);
	}

	public upsertData(filePath: string, data: string): void {
		const pathHashDigest = this.__buildPathHashDigest(filePath);

		const unifiedFile: UnifiedFile = {
			kind: 'file',
			path: filePath,
		};

		this.__entries.set(pathHashDigest, unifiedFile);

		this.__changes.set(pathHashDigest, data);
	}

	public buildExternalFileCommands(): readonly ExternalFileCommand[] {
		const commands: ExternalFileCommand[] = [];

		this.__changes.forEach((data, hashDigest) => {
			const entry = this.__entries.get(hashDigest);

			if (entry && data === null) {
				commands.push({
					kind: 'deleteFile',
					path: entry.path,
				});
			}

			if (entry && data !== null) {
				commands.push({
					kind: 'upsertFile',
					path: entry.path,
					data,
				});
			}
		});

		return commands;
	}
}
