import { lstatSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import {
	prepareMySqlDbPushSnapshot,
	prepareMySqlMigrationSnapshot,
	preparePgDbPushSnapshot,
	preparePgMigrationSnapshot,
	prepareSQLiteDbPushSnapshot,
	prepareSqliteMigrationSnapshot,
} from '../../migrationPreparator';

import chalk from 'chalk';
import { render } from 'hanji';
import { join } from 'path';
import { TypeOf } from 'zod';
import type { CommonSchema } from '../../schemaValidator';
import { MySqlSchema, mysqlSchema, squashMysqlScheme } from '../../serializer/mysqlSchema';
import { PgSchema, pgSchema, squashPgScheme } from '../../serializer/pgSchema';
import { SQLiteSchema, sqliteSchema, squashSqliteScheme } from '../../serializer/sqliteSchema';
import {
	applyMysqlSnapshotsDiff,
	applyPgSnapshotsDiff,
	applySqliteSnapshotsDiff,
	Column,
	ColumnsResolverInput,
	ColumnsResolverOutput,
	Enum,
	ResolverInput,
	ResolverOutput,
	ResolverOutputWithMoved,
	Sequence,
	Table,
} from '../../snapshotsDiffer';
import { assertV3OutFolder, Journal, prepareMigrationFolder } from '../../utils';
import { prepareMigrationMetadata } from '../../utils/words';
import { withStyle } from '../validations/outputs';
import {
	isRenamePromptItem,
	RenamePropmtItem,
	ResolveColumnSelect,
	ResolveSchemasSelect,
	ResolveSelect,
	schema,
} from '../views';
import { GenerateConfig } from './utils';

export type Named = {
	name: string;
};

export type NamedWithSchema = {
	name: string;
	schema: string;
};

export const schemasResolver = async (
	input: ResolverInput<Table>,
): Promise<ResolverOutput<Table>> => {
	try {
		const { created, deleted, renamed } = await promptSchemasConflict(
			input.created,
			input.deleted,
		);

		return { created: created, deleted: deleted, renamed: renamed };
	} catch (e) {
		console.error(e);
		throw e;
	}
};

export const tablesResolver = async (
	input: ResolverInput<Table>,
): Promise<ResolverOutputWithMoved<Table>> => {
	try {
		const { created, deleted, moved, renamed } = await promptNamedWithSchemasConflict(
			input.created,
			input.deleted,
			'table',
		);

		return {
			created: created,
			deleted: deleted,
			moved: moved,
			renamed: renamed,
		};
	} catch (e) {
		console.error(e);
		throw e;
	}
};

export const sequencesResolver = async (
	input: ResolverInput<Sequence>,
): Promise<ResolverOutputWithMoved<Sequence>> => {
	try {
		const { created, deleted, moved, renamed } = await promptNamedWithSchemasConflict(
			input.created,
			input.deleted,
			'sequence',
		);

		return {
			created: created,
			deleted: deleted,
			moved: moved,
			renamed: renamed,
		};
	} catch (e) {
		console.error(e);
		throw e;
	}
};

export const enumsResolver = async (
	input: ResolverInput<Enum>,
): Promise<ResolverOutputWithMoved<Enum>> => {
	try {
		const { created, deleted, moved, renamed } = await promptNamedWithSchemasConflict(
			input.created,
			input.deleted,
			'enum',
		);

		return {
			created: created,
			deleted: deleted,
			moved: moved,
			renamed: renamed,
		};
	} catch (e) {
		console.error(e);
		throw e;
	}
};

export const columnsResolver = async (
	input: ColumnsResolverInput<Column>,
): Promise<ColumnsResolverOutput<Column>> => {
	const result = await promptColumnsConflicts(
		input.tableName,
		input.created,
		input.deleted,
	);
	return {
		tableName: input.tableName,
		schema: input.schema,
		created: result.created,
		deleted: result.deleted,
		renamed: result.renamed,
	};
};

export const prepareAndMigratePg = async (config: GenerateConfig) => {
	const outFolder = config.out;
	const schemaPath = config.schema;

	try {
		assertV3OutFolder(outFolder);

		const snapshots = prepareMigrationFolder(
			outFolder,
			'postgresql',
		);

		const { prev, cur, custom } = await preparePgMigrationSnapshot(
			snapshots,
			schemaPath,
		);

		const validatedPrev = pgSchema.parse(prev);
		const validatedCur = pgSchema.parse(cur);

		if (config.custom) {
			writeResult({
				cur: custom,
				sqlStatements: [],
				outFolder,
				name: config.name,
				breakpoints: config.breakpoints,
				type: 'custom',
			});
			return;
		}

		const squashedPrev = squashPgScheme(validatedPrev);
		const squashedCur = squashPgScheme(validatedCur);

		const { sqlStatements, _meta } = await applyPgSnapshotsDiff(
			squashedPrev,
			squashedCur,
			schemasResolver,
			enumsResolver,
			sequencesResolver,
			tablesResolver,
			columnsResolver,
			validatedPrev,
			validatedCur,
		);

		writeResult({
			cur,
			sqlStatements,
			outFolder,
			name: config.name,
			breakpoints: config.breakpoints,
		});
	} catch (e) {
		console.error(e);
	}
};

export const preparePgPush = async (
	schemaPath: string | string[],
	snapshot: PgSchema,
	schemaFilter: string[],
) => {
	const { prev, cur } = await preparePgDbPushSnapshot(
		snapshot,
		schemaPath,
		schemaFilter,
	);

	const validatedPrev = pgSchema.parse(prev);
	const validatedCur = pgSchema.parse(cur);

	const squashedPrev = squashPgScheme(validatedPrev, 'push');
	const squashedCur = squashPgScheme(validatedCur, 'push');

	const { sqlStatements, statements, _meta } = await applyPgSnapshotsDiff(
		squashedPrev,
		squashedCur,
		schemasResolver,
		enumsResolver,
		sequencesResolver,
		tablesResolver,
		columnsResolver,
		validatedPrev,
		validatedCur,
		'push',
	);

	return { sqlStatements, statements, squashedPrev, squashedCur };
};

// Not needed for now
function mysqlSchemaSuggestions(
	curSchema: TypeOf<typeof mysqlSchema>,
	prevSchema: TypeOf<typeof mysqlSchema>,
) {
	const suggestions: string[] = [];
	const usedSuggestions: string[] = [];
	const suggestionTypes = {
		serial: withStyle.errorWarning(
			`We deprecated the use of 'serial' for MySQL starting from version 0.20.0. In MySQL, 'serial' is simply an alias for 'bigint unsigned not null auto_increment unique,' which creates all constraints and indexes for you. This may make the process less explicit for both users and drizzle-kit push commands`,
		),
	};

	for (const table of Object.values(curSchema.tables)) {
		for (const column of Object.values(table.columns)) {
			if (column.type === 'serial') {
				if (!usedSuggestions.includes('serial')) {
					suggestions.push(suggestionTypes['serial']);
				}

				const uniqueForSerial = Object.values(
					prevSchema.tables[table.name].uniqueConstraints,
				).find((it) => it.columns[0] === column.name);

				suggestions.push(
					`\n`
						+ withStyle.suggestion(
							`We are suggesting to change ${
								chalk.blue(
									column.name,
								)
							} column in ${
								chalk.blueBright(
									table.name,
								)
							} table from serial to bigint unsigned\n\n${
								chalk.blueBright(
									`bigint("${column.name}", { mode: "number", unsigned: true }).notNull().autoincrement().unique(${
										uniqueForSerial?.name ? `"${uniqueForSerial?.name}"` : ''
									})`,
								)
							}`,
						),
				);
			}
		}
	}

	return suggestions;
}

// Intersect with prepareAnMigrate
export const prepareMySQLPush = async (
	schemaPath: string | string[],
	snapshot: MySqlSchema,
) => {
	try {
		const { prev, cur } = await prepareMySqlDbPushSnapshot(
			snapshot,
			schemaPath,
		);

		const validatedPrev = mysqlSchema.parse(prev);
		const validatedCur = mysqlSchema.parse(cur);

		const squashedPrev = squashMysqlScheme(validatedPrev);
		const squashedCur = squashMysqlScheme(validatedCur);

		const { sqlStatements, statements } = await applyMysqlSnapshotsDiff(
			squashedPrev,
			squashedCur,
			tablesResolver,
			columnsResolver,
			validatedPrev,
			validatedCur,
			'push',
		);

		return { sqlStatements, statements, validatedCur, validatedPrev };
	} catch (e) {
		console.error(e);
		process.exit(1);
	}
};

export const prepareAndMigrateMysql = async (config: GenerateConfig) => {
	const outFolder = config.out;
	const schemaPath = config.schema;

	try {
		assertV3OutFolder(outFolder);

		const snapshots = prepareMigrationFolder(outFolder, 'mysql');
		const { prev, cur, custom } = await prepareMySqlMigrationSnapshot(
			snapshots,
			schemaPath,
		);

		const validatedPrev = mysqlSchema.parse(prev);
		const validatedCur = mysqlSchema.parse(cur);

		if (config.custom) {
			writeResult({
				cur: custom,
				sqlStatements: [],
				outFolder,
				name: config.name,
				breakpoints: config.breakpoints,
				type: 'custom',
			});
			return;
		}

		const squashedPrev = squashMysqlScheme(validatedPrev);
		const squashedCur = squashMysqlScheme(validatedCur);

		const { sqlStatements, statements, _meta } = await applyMysqlSnapshotsDiff(
			squashedPrev,
			squashedCur,
			tablesResolver,
			columnsResolver,
			validatedPrev,
			validatedCur,
		);

		writeResult({
			cur,
			sqlStatements,
			_meta,
			outFolder,
			name: config.name,
			breakpoints: config.breakpoints,
		});
	} catch (e) {
		console.error(e);
	}
};

export const prepareAndMigrateSqlite = async (config: GenerateConfig) => {
	const outFolder = config.out;
	const schemaPath = config.schema;

	try {
		assertV3OutFolder(outFolder);

		const snapshots = prepareMigrationFolder(outFolder, 'sqlite');
		const { prev, cur, custom } = await prepareSqliteMigrationSnapshot(
			snapshots,
			schemaPath,
		);

		const validatedPrev = sqliteSchema.parse(prev);
		const validatedCur = sqliteSchema.parse(cur);

		if (config.custom) {
			writeResult({
				cur: custom,
				sqlStatements: [],
				outFolder,
				name: config.name,
				breakpoints: config.breakpoints,
				bundle: config.bundle,
				type: 'custom',
			});
			return;
		}

		const squashedPrev = squashSqliteScheme(validatedPrev);
		const squashedCur = squashSqliteScheme(validatedCur);

		const { sqlStatements, _meta } = await applySqliteSnapshotsDiff(
			squashedPrev,
			squashedCur,
			tablesResolver,
			columnsResolver,
			validatedPrev,
			validatedCur,
		);

		writeResult({
			cur,
			sqlStatements,
			_meta,
			outFolder,
			name: config.name,
			breakpoints: config.breakpoints,
			bundle: config.bundle,
		});
	} catch (e) {
		console.error(e);
	}
};

export const prepareSQLitePush = async (
	schemaPath: string | string[],
	snapshot: SQLiteSchema,
) => {
	const { prev, cur } = await prepareSQLiteDbPushSnapshot(snapshot, schemaPath);

	const validatedPrev = sqliteSchema.parse(prev);
	const validatedCur = sqliteSchema.parse(cur);

	const squashedPrev = squashSqliteScheme(validatedPrev, 'push');
	const squashedCur = squashSqliteScheme(validatedCur, 'push');

	const { sqlStatements, statements, _meta } = await applySqliteSnapshotsDiff(
		squashedPrev,
		squashedCur,
		tablesResolver,
		columnsResolver,
		validatedPrev,
		validatedCur,
		'push',
	);

	return {
		sqlStatements,
		statements,
		squashedPrev,
		squashedCur,
		meta: _meta,
	};
};

const freeeeeeze = (obj: any) => {
	Object.freeze(obj);
	for (let key in obj) {
		if (obj.hasOwnProperty(key) && typeof obj[key] === 'object') {
			freeeeeeze(obj[key]);
		}
	}
};

export const promptColumnsConflicts = async <T extends Named>(
	tableName: string,
	newColumns: T[],
	missingColumns: T[],
) => {
	if (newColumns.length === 0 || missingColumns.length === 0) {
		return { created: newColumns, renamed: [], deleted: missingColumns };
	}
	const result: { created: T[]; renamed: { from: T; to: T }[]; deleted: T[] } = {
		created: [],
		renamed: [],
		deleted: [],
	};

	let index = 0;
	let leftMissing = [...missingColumns];

	do {
		const created = newColumns[index];

		const renames: RenamePropmtItem<T>[] = leftMissing.map((it) => {
			return { from: it, to: created };
		});

		const promptData: (RenamePropmtItem<T> | T)[] = [created, ...renames];

		const { status, data } = await render(
			new ResolveColumnSelect<T>(tableName, created, promptData),
		);
		if (status === 'aborted') {
			console.error('ERROR');
			process.exit(1);
		}

		if (isRenamePromptItem(data)) {
			console.log(
				`${chalk.yellow('~')} ${data.from.name} › ${data.to.name} ${
					chalk.gray(
						'column will be renamed',
					)
				}`,
			);
			result.renamed.push(data);
			// this will make [item1, undefined, item2]
			delete leftMissing[leftMissing.indexOf(data.from)];
			// this will make [item1, item2]
			leftMissing = leftMissing.filter(Boolean);
		} else {
			console.log(
				`${chalk.green('+')} ${data.name} ${
					chalk.gray(
						'column will be created',
					)
				}`,
			);
			result.created.push(created);
		}
		index += 1;
	} while (index < newColumns.length);
	console.log(
		chalk.gray(`--- all columns conflicts in ${tableName} table resolved ---\n`),
	);

	result.deleted.push(...leftMissing);
	return result;
};

export const promptNamedWithSchemasConflict = async <T extends NamedWithSchema>(
	newItems: T[],
	missingItems: T[],
	entity: 'table' | 'enum' | 'sequence',
): Promise<{
	created: T[];
	renamed: { from: T; to: T }[];
	moved: { name: string; schemaFrom: string; schemaTo: string }[];
	deleted: T[];
}> => {
	if (missingItems.length === 0 || newItems.length === 0) {
		return {
			created: newItems,
			renamed: [],
			moved: [],
			deleted: missingItems,
		};
	}

	const result: {
		created: T[];
		renamed: { from: T; to: T }[];
		moved: { name: string; schemaFrom: string; schemaTo: string }[];
		deleted: T[];
	} = { created: [], renamed: [], moved: [], deleted: [] };
	let index = 0;
	let leftMissing = [...missingItems];
	do {
		const created = newItems[index];
		const renames: RenamePropmtItem<T>[] = leftMissing.map((it) => {
			return { from: it, to: created };
		});

		const promptData: (RenamePropmtItem<T> | T)[] = [created, ...renames];

		const { status, data } = await render(
			new ResolveSelect<T>(created, promptData, entity),
		);
		if (status === 'aborted') {
			console.error('ERROR');
			process.exit(1);
		}

		if (isRenamePromptItem(data)) {
			const schemaFromPrefix = !data.from.schema || data.from.schema === 'public'
				? ''
				: `${data.from.schema}.`;
			const schemaToPrefix = !data.to.schema || data.to.schema === 'public'
				? ''
				: `${data.to.schema}.`;

			console.log(
				`${chalk.yellow('~')} ${schemaFromPrefix}${data.from.name} › ${schemaToPrefix}${data.to.name} ${
					chalk.gray(
						`${entity} will be renamed/moved`,
					)
				}`,
			);

			if (data.from.name !== data.to.name) {
				result.renamed.push(data);
			}

			if (data.from.schema !== data.to.schema) {
				result.moved.push({
					name: data.from.name,
					schemaFrom: data.from.schema || 'public',
					schemaTo: data.to.schema || 'public',
				});
			}

			delete leftMissing[leftMissing.indexOf(data.from)];
			leftMissing = leftMissing.filter(Boolean);
		} else {
			console.log(
				`${chalk.green('+')} ${data.name} ${
					chalk.gray(
						`${entity} will be created`,
					)
				}`,
			);
			result.created.push(created);
		}
		index += 1;
	} while (index < newItems.length);
	console.log(chalk.gray(`--- all ${entity} conflicts resolved ---\n`));
	result.deleted.push(...leftMissing);
	return result;
};

export const promptSchemasConflict = async <T extends Named>(
	newSchemas: T[],
	missingSchemas: T[],
): Promise<{ created: T[]; renamed: { from: T; to: T }[]; deleted: T[] }> => {
	if (missingSchemas.length === 0 || newSchemas.length === 0) {
		return { created: newSchemas, renamed: [], deleted: missingSchemas };
	}

	const result: { created: T[]; renamed: { from: T; to: T }[]; deleted: T[] } = {
		created: [],
		renamed: [],
		deleted: [],
	};
	let index = 0;
	let leftMissing = [...missingSchemas];
	do {
		const created = newSchemas[index];
		const renames: RenamePropmtItem<T>[] = leftMissing.map((it) => {
			return { from: it, to: created };
		});

		const promptData: (RenamePropmtItem<T> | T)[] = [created, ...renames];

		const { status, data } = await render(
			new ResolveSchemasSelect<T>(created, promptData),
		);
		if (status === 'aborted') {
			console.error('ERROR');
			process.exit(1);
		}

		if (isRenamePromptItem(data)) {
			console.log(
				`${chalk.yellow('~')} ${data.from.name} › ${data.to.name} ${
					chalk.gray(
						'schema will be renamed',
					)
				}`,
			);
			result.renamed.push(data);
			delete leftMissing[leftMissing.indexOf(data.from)];
			leftMissing = leftMissing.filter(Boolean);
		} else {
			console.log(
				`${chalk.green('+')} ${data.name} ${
					chalk.gray(
						'schema will be created',
					)
				}`,
			);
			result.created.push(created);
		}
		index += 1;
	} while (index < newSchemas.length);
	console.log(chalk.gray('--- all schemas conflicts resolved ---\n'));
	result.deleted.push(...leftMissing);
	return result;
};

export const BREAKPOINT = '--> statement-breakpoint\n';

export const writeResult = ({
	cur,
	sqlStatements,
	_meta = {
		columns: {},
		schemas: {},
		tables: {},
	},
	outFolder,
	breakpoints,
	name,
	bundle = false,
	type = 'none',
}: {
	cur: CommonSchema;
	sqlStatements: string[];
	_meta?: any;
	outFolder: string;
	breakpoints: boolean;
	name?: string;
	bundle?: boolean;
	type?: 'introspect' | 'custom' | 'none';
}) => {
	if (type === 'none') {
		console.log(schema(cur));

		// if you delete migration folder manually, for expo sqlite and op-sqlite - we need to regenerate migrations.js
		if (bundle) {
			const js = embeddedMigrations(outFolder);
			writeFileSync(`${outFolder}/migrations.js`, js);
			render(
				`[${
					chalk.green(
						'✓',
					)
				}] ${outFolder}/migrations.js file updated`,
			);
		}

		if (sqlStatements.length === 0) {
			console.log('No schema changes, nothing to migrate 😴');
			return;
		}
	}

	const { prefix, tag } = prepareMigrationMetadata(name);

	const toSave = JSON.parse(JSON.stringify(cur));
	toSave['_meta'] = _meta;

	const sqlDelimiter = breakpoints ? BREAKPOINT : '\n';
	let sql = sqlStatements.join(sqlDelimiter);

	if (type === 'introspect') {
		sql =
			`-- Current sql file was generated after introspecting the database\n-- If you want to run this migration please uncomment this code before executing migrations\n/*\n${sql}\n*/`;
	}

	if (type === 'custom') {
		console.log('Prepared empty file for your custom SQL migration!');
		sql = '-- Custom SQL migration file, put you code below! --';
	}

	const migrationFolder = join(outFolder, tag);
	mkdirSync(migrationFolder, { recursive: true });

	writeFileSync(
		join(migrationFolder, `snapshot.json`),
		JSON.stringify(toSave, null, 2),
	);
	writeFileSync(join(migrationFolder, 'migration.sql'), sql);

	// js file with .sql imports for React Native / Expo
	if (bundle) {
		const js = embeddedMigrations(outFolder);
		writeFileSync(`${outFolder}/migrations.js`, js);
	}

	render(
		`[${
			chalk.green(
				'✓',
			)
		}] Your SQL migration file ➜ ${
			chalk.bold.underline.blue(
				join(`${migrationFolder}/migration.sql`),
			)
		} 🚀`,
	);
};

const timestampToMillis = (timestamp: string) => {
	const year = timestamp.slice(0, 4);
	const month = timestamp.slice(4, 6);
	const day = timestamp.slice(6, 8);
	const hr = timestamp.slice(8, 10);
	const min = timestamp.slice(10, 12);
	const sec = timestamp.slice(12, 14);
	const isoString = `${year}-${month}-${day}T${hr}:${min}:${sec}.000Z`;
	return +new Date(isoString);
};

export const embeddedMigrations = (outFolder: string) => {
	let content =
		'// This file is required for Expo/React Native SQLite migrations - https://orm.drizzle.team/quick-sqlite/expo\n\n';

	let journalEntries = ``;
	const migrationFolders = readdirSync(outFolder).filter((it) => lstatSync(join(outFolder, it)).isDirectory());
	migrationFolders.forEach((entry, idx) => {
		const importName = `m${idx.toString().padStart(4, '0')}`;
		content += `import ${importName} from './${entry}/migration.sql';\n`;
		const millis = timestampToMillis(entry.slice(0, 14));
		journalEntries += `\n{ idx: ${idx}, when: ${millis} }, `;
	});

	content += `
export default {
	journal: {
		entries: [${journalEntries}]
	},
	migrations: {
		${migrationFolders.map((_, idx) => `m${idx.toString().padStart(4, '0')}`).join(',\n')}
	}
}
  `;
	return content;
};

export const prepareSnapshotFolderName = () => {
	const now = new Date();
	return `${now.getFullYear()}${two(now.getUTCMonth() + 1)}${
		two(
			now.getUTCDate(),
		)
	}${two(now.getUTCHours())}${two(now.getUTCMinutes())}${
		two(
			now.getUTCSeconds(),
		)
	}`;
};

const two = (input: number): string => {
	return input.toString().padStart(2, '0');
};
