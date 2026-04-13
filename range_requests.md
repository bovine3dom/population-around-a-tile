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

as always it was just bloody node_modules being haunted. it works fine now

```
convertArrowToTable(await (await dbp).query("select 1"), 'arrow-table')
```



ok we have this working now and as suspected it is _way_ slower than just using files

notes for making the parquet file:

```
# single file with row groups for range requests
using Arrow, DataFrames
import H3, Tables
df4 = Arrow.Table("kontur_population/kontur_population_20231101.arrow") |> DataFrame

kontur_res = H3.API.getResolution(df4.h3[1])
inner_tile_diff = 3
df_batches = DataFrame(tile_id=UInt64[], index=UInt64[], value=Float64[], weight=Float64[])#, res=UInt8[])
for tile_res in 0:(kontur_res-inner_tile_diff)
# for tile_res in 0:2
    @show "doing tile_res=$tile_res"
    target_res = tile_res + inner_tile_diff
    df4.index = H3.API.cellToParent.(df4.h3, target_res)
    df_t = combine(groupby(df4, :index), :population => sum => :weight)
    df_t.value = round.(df_t.weight ./ H3.API.cellAreaKm2.(df_t.index), sigdigits=3)
    df_t.tile_id = H3.API.cellToParent.(df_t.index, tile_res)
    append!(df_batches, df_t[!, [:tile_id, :index, :value, :weight]])
end
# g = groupby(df_batches, :tile_id)
# # write a stream rather than file format
# open("kontur_batched3.arrow", "w") do io
#     Arrow.write(io, Tables.partitioner(g))
# end

# ... eugh but then it has to stream the whole bloody thing?
import QuackIO
sort!(df_batches, :tile_id)
QuackIO.write_table("kontur_batched3.parquet", df_batches)
# this works fine
```
