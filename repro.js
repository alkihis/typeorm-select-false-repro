require("reflect-metadata");
const { DataSource, EntitySchema } = require("typeorm");

// Same shape as the original project: a ValueTransformer that maps strings to a
// value object and passes undefined/null through untouched.
class Day {
  constructor(iso) {
    this.iso = iso;
  }
}
const dayArrayTransformer = {
  from: (value) => (value == null ? value : value.map((iso) => new Day(iso))),
  to: (value) => (value == null ? value : value.map((day) => day.iso)),
};

function entity(name, hiddenColumn) {
  return new EntitySchema({
    name,
    tableName: name.toLowerCase(),
    columns: {
      id: { type: Number, primary: true, generated: true },
      label: { type: String },
      hidden: { ...hiddenColumn, nullable: true, select: false },
    },
  });
}

const cases = [
  {
    name: "DateArrayWithTransformer",
    column: { type: "date", array: true, transformer: dayArrayTransformer },
    value: [new Day("2026-01-05"), new Day("2026-01-06")],
  },
  {
    name: "DateArray",
    column: { type: "date", array: true },
    value: ["2026-01-05", "2026-01-06"],
  },
  {
    name: "TimestampArray",
    column: { type: "timestamp", array: true },
    value: [new Date("2026-01-05T08:00:00Z")],
  },
  {
    name: "TimeArray",
    column: { type: "time", array: true },
    value: ["08:00:00", "17:30:00"],
  },
  {
    name: "IntArray",
    column: { type: "int", array: true },
    value: [1, 2, 3],
  },
  {
    name: "DateScalar",
    column: { type: "date" },
    value: "2026-01-05",
  },
  {
    name: "IntScalar",
    column: { type: "int" },
    value: 42,
  },
];

const updates = [];
const dataSource = new DataSource({
  type: "postgres",
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 55432),
  username: "repro",
  password: "repro",
  database: "repro",
  entities: cases.map((c) => entity(c.name, c.column)),
  synchronize: true,
  dropSchema: true,
  logging: ["query"],
  logger: {
    logQuery: (query) => {
      if (query.startsWith("UPDATE")) updates.push(query);
    },
    logQueryError() {},
    logQuerySlow() {},
    logSchemaBuild() {},
    logMigration() {},
    log() {},
  },
});

async function loadWithHidden(repository, id) {
  return repository
    .createQueryBuilder("e")
    .addSelect("e.hidden")
    .where("e.id = :id", { id })
    .getOneOrFail();
}

async function runCase(testCase) {
  const repository = dataSource.getRepository(testCase.name);
  const { id } = await repository.save({ label: "before", hidden: testCase.value });

  const loaded = await loadWithHidden(repository, id);
  loaded.label = "after save";
  updates.length = 0;
  let saveResult;
  try {
    await repository.save(loaded);
    saveResult = `OK, UPDATE sent: ${updates.join(" | ") || "(none)"}`;
  } catch (error) {
    saveResult = `CRASH ${error.constructor.name}: ${error.message}`;
  }

  let updateResult;
  try {
    await repository.update(id, { label: "after update" });
    const reloaded = await repository.findOneByOrFail({ id });
    updateResult = `OK, label=${JSON.stringify(reloaded.label)}`;
  } catch (error) {
    updateResult = `CRASH ${error.constructor.name}: ${error.message}`;
  }

  return { saveResult, updateResult };
}

async function main() {
  await dataSource.initialize();
  const { version } = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "node_modules/typeorm/package.json"), "utf8"));
  const [{ server_version }] = await dataSource.query("SHOW server_version");
  console.log(`typeorm ${version}, PostgreSQL ${server_version}, Node ${process.version}\n`);

  let crashes = 0;
  for (const testCase of cases) {
    const { saveResult, updateResult } = await runCase(testCase);
    if (saveResult.startsWith("CRASH")) crashes++;
    console.log(`${testCase.name} (${JSON.stringify(testCase.column.type)}${testCase.column.array ? "[]" : ""}, select: false)`);
    console.log(`  repository.save   -> ${saveResult}`);
    console.log(`  repository.update -> ${updateResult}`);
  }

  await dataSource.destroy();
  console.log(`\n${crashes} of ${cases.length} cases crashed in repository.save()`);
  process.exitCode = crashes > 0 ? 1 : 0;
}

main().catch(async (error) => {
  console.error(error);
  if (dataSource.isInitialized) await dataSource.destroy();
  process.exitCode = 2;
});
