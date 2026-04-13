1) check github pages supports range requests
```
curl -v -r 0-99 "https://o.blanthorn.com/population-around-a-tile/map/data/kontur_export/tile_id=85970677fffffff/part0.arrow"
```

look for http 206 - which works! yey!

2) check duckdb really does support arrow. nb: needs v1.5.1 or later for arrow

```
INSTALL nanoarrow from community;
LOAD 'nanoarrow';
SELECT * 
FROM read_arrow('https://o.blanthorn.com/population-around-a-tile/map/data/kontur_export/tile_id=85970677fffffff/part0.arrow')
LIMIT 10;
```
<!-- WHERE h3_index IN (61287123, 61287124, ...); -->

3) check duckdb wasm supports arrow

```
SELECT * 
FROM read_arrow('https://o.blanthorn.com/population-around-a-tile/map/data/kontur_export/tile_id=85970677fffffff/part0.arrow')
LIMIT 10;
```

yes! but it breaks the rest of our arrow support. so that's nice.

4) ... kick tyres

```
fq(`SELECT * FROM read_arrow('https://o.blanthorn.com/population-around-a-tile/map/data/kontur_export/tile_id=85970677fffffff/part0.arrow') LIMIT 10_000;`)


app.ts:1077 {timestamp: Mon Apr 13 2026 14:40:35 GMT+0200 (Central European Summer Time), level: 2, origin: 4, topic: 4, event: 4, …}
undefined
f680b758-e5ba-43bd-a373-9a193a626728:1 Error: Invalid Input Error: arrow_scan: get_next failed(): IOException: {"exception_type":"IO","exception_message":"Expected continuation token (0xFFFFFFFF) but got 20"}
    at ha.runQuery (f680b758-e5ba-43bd-a373-9a193a626728:1:738694)
    at xo.onMessage (f680b758-e5ba-43bd-a373-9a193a626728:1:749315)
    at globalThis.onmessage (f680b758-e5ba-43bd-a373-9a193a626728:1:772483)
duckdb-browser.mjs:1 Uncaught (in promise) Error: Invalid Input Error: arrow_scan: get_next failed(): IOException: {"exception_type":"IO","exception_message":"Expected continuation token (0xFFFFFFFF) but got 20"}
    at f2.onMessage (duckdb-browser.mjs:1:11860)
onMessage @ duckdb-browser.mjs:1
```

so that's nice. smaller limits work. maybe it doesn't like our arrow files made by julia?

... oddly

```
fq("select population from read_arrow('http://localhost:1980/kontur_population_20231101.arrow') order by population desc limit 10")
```

works fine. so maybe it is something with julia?


ok so duckdb only supports ipc arrow, not files, which don't have the metadata stuff so rannge requests just request the whole file
(can write arrow stream ipc files with julia via arrow.write(IO NOT A STRING, df))

sorting the df then writing it with quackio works great, range requests work.

which lets us get to our next problem: we have the same arrow error we got when we first installed duckdb.

```
convertArrowToTable(pq, 'arrow-table')
convert-arrow-schema.js:196 Uncaught Error: arrow type not supported: Int_2
    at serializeArrowType (convert-arrow-schema.js:196:19)
    at serializeArrowField (convert-arrow-schema.js:36:15)
    at convert-arrow-schema.js:16:56
    at Array.map (<anonymous>)
    at serializeArrowSchema (convert-arrow-schema.js:16:36)
    at convertArrowToSchema (convert-arrow-schema.js:7:12)
    at convertArrowToArrowTable (convert-arrow-table.js:57:17)
    at convertArrowToTable (convert-arrow-table.js:35:20)
    at <anonymous>:1:1
```

we could just reimplement the bit of the schema that we need...
