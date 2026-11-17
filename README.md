# `repository.save()` crashes on a `select: false` date/time array column loaded with `addSelect` (PostgreSQL)

## Issue description

An entity has a `select: false` column of type `date`, `time` or `timestamp` with `array: true`. When the entity is loaded **with** that column (`.addSelect("e.hidden")`) and then saved with `repository.save(entity)` after changing any other property, `save` throws:

```
TypeError: Cannot read properties of undefined (reading 'map')
    at node_modules/typeorm/persistence/SubjectChangedColumnsComputer.js:87:49
    at Array.forEach (<anonymous>)
    at SubjectChangedColumnsComputer.computeDiffColumns (node_modules/typeorm/persistence/SubjectChangedColumnsComputer.js:39:34)
    at node_modules/typeorm/persistence/SubjectChangedColumnsComputer.js:23:18
```

`repository.update(id, { ... })` on the same row works.

Related:

- #11514 is the same crash with a `null` database value (`Cannot read properties of null (reading 'map')`). It was fixed by #11532, which added the `databaseValue !== null` guard. A `select: false` column yields `undefined`, which still gets past that guard.
- #12473 / #12501 is a different problem: the removal of the post-save delete of `select: false` properties, released in 0.3.31 and 1.1.0. The crash reported here happens earlier, before any query is sent, while the diff is computed.

## Expected behavior

`save()` updates the row. A `select: false` column whose value is present on the entity is either compared against its real database value or treated as changed (which is what already happens for scalar and non-date array `select: false` columns, see the output below).

## Actual behavior

`save()` throws a `TypeError` for `date[]`, `time[]` and `timestamp[]` columns. A `ValueTransformer` is not needed to trigger it.

## Steps to reproduce

```js
const Thing = new EntitySchema({
  name: "Thing",
  columns: {
    id: { type: Number, primary: true, generated: true },
    label: { type: String },
    hidden: { type: "date", array: true, nullable: true, select: false },
    // decorator equivalent: @Column("date", { array: true, nullable: true, select: false })
  },
});

const repository = dataSource.getRepository(Thing);
const { id } = await repository.save({ label: "before", hidden: ["2026-01-05"] });

const loaded = await repository
  .createQueryBuilder("e")
  .addSelect("e.hidden")
  .where("e.id = :id", { id })
  .getOneOrFail();

loaded.label = "after";
await repository.save(loaded); // TypeError: Cannot read properties of undefined (reading 'map')
```

Full runnable reproduction in this folder:

```bash
npm install
npm run db:up      # throwaway postgres:16 on localhost:55432 (docker compose)
npm run repro      # exit code 1 when save() crashes
npm run db:down
```

`repro.js` runs the same flow for 7 `select: false` column types, then checks `repository.update()` on each.

### Output

```
typeorm 1.1.3, PostgreSQL 16.16 (Debian 16.16-1.pgdg13+1), Node v26.11.1

DateArrayWithTransformer ("date"[], select: false)
  repository.save   -> CRASH TypeError: Cannot read properties of undefined (reading 'map')
  repository.update -> OK, label="after update"
DateArray ("date"[], select: false)
  repository.save   -> CRASH TypeError: Cannot read properties of undefined (reading 'map')
  repository.update -> OK, label="after update"
TimestampArray ("timestamp"[], select: false)
  repository.save   -> CRASH TypeError: Cannot read properties of undefined (reading 'map')
  repository.update -> OK, label="after update"
TimeArray ("time"[], select: false)
  repository.save   -> CRASH TypeError: Cannot read properties of undefined (reading 'map')
  repository.update -> OK, label="after update"
IntArray ("int"[], select: false)
  repository.save   -> OK, UPDATE sent: UPDATE "intarray" SET "label" = $1, "hidden" = $2 WHERE "id" = $3
  repository.update -> OK, label="after update"
DateScalar ("date", select: false)
  repository.save   -> OK, UPDATE sent: UPDATE "datescalar" SET "label" = $1, "hidden" = $2 WHERE "id" = $3
  repository.update -> OK, label="after update"
IntScalar ("int", select: false)
  repository.save   -> OK, UPDATE sent: UPDATE "intscalar" SET "label" = $1, "hidden" = $2 WHERE "id" = $3
  repository.update -> OK, label="after update"

4 of 7 cases crashed in repository.save()
```

Non-crashing `select: false` columns are always treated as changed and rewritten (`"hidden" = $2`), even though their value did not change: harmless, but it shows the database value is never known for them.

## Cause

1. Before an update, `SubjectDatabaseEntityLoader` reloads the database entity with a plain query builder and find options that do not mention `select: false` columns (`persistence/SubjectDatabaseEntityLoader.js`, lines 73-95):

   ```js
   const findOptions = {
       loadEagerRelations: false,
       loadRelationIds: { relations: loadRelationPropertyPaths, disableMixedMap: true },
       withDeleted: true,
   };
   // ...
   entities = await this.queryRunner.manager
       .getRepository(subjectGroup.target)
       .createQueryBuilder()
       .setFindOptions(findOptions)
       .whereInIds(allIds)
       .getMany();
   ```

   The default selection keeps only `column.isSelect === true` (`query-builder/SelectQueryBuilder.js`, line 1702), so `subject.databaseEntity.hidden` is `undefined`.

2. `SubjectChangedColumnsComputer.computeDiffColumns` only skips `undefined` on the **entity** side (line 55: `if (entityValue === undefined) return;`). On the database side it only guards against `null` (line 80), then the date/time branches call `.map` on the database value for array columns (`persistence/SubjectChangedColumnsComputer.js`, lines 80-114):

   ```js
   if (normalizedValue !== null && databaseValue !== null) {
       switch (column.type) {
           case "date":
               // ...
               databaseValue = column.isArray
                   ? databaseValue.map((date) => DateUtils.mixedDateToDateString(date))   // line 87, databaseValue is undefined
                   : DateUtils.mixedDateToDateString(databaseValue, { utc: column.utc });
               break;
           case "time": // ... same pattern, line 98
           case "timestamp": // ... same pattern, line 113
   ```

   Scalar types get `undefined` through `DateUtils` without throwing, and non-date arrays skip the switch, so they end up "changed" instead of crashing.

## Suggested fix

Either of:

- In `computeDiffColumns`, treat `databaseValue === undefined` as "unknown": skip the normalisation switch (guard `databaseValue !== undefined && databaseValue !== null`) so the column is marked as changed, like every other `select: false` column already is. Smallest change, keeps current semantics.
- In `SubjectDatabaseEntityLoader`, also select the `select: false` columns that the persisted entity carries (`entityValue !== undefined`), so the diff compares against the real database value and no needless write happens.

Workaround: use `repository.update(id, changedFields)` instead of `save()` for such entities.

## Environment

| | |
|---|---|
| TypeORM | 1.1.3 |
| Database | PostgreSQL 16.16 (`postgres:16` image) |
| Driver | pg 8.13.1 |
| Node.js | v26.11.1 |
| OS | macOS (Darwin 27.2.0) |

Also observed in a NestJS application with a decorator entity and a `ValueTransformer` mapping strings to a value object; the transformer is not involved (the `DateArray` case has none).
