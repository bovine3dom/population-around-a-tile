rambling about static file server

1) work out how to write from clickhouse to parquet hive directory
2) check what relationship of tile resolution to inner hexes makes sense: we currently use +3. maybe a better idea would be to look to see what we use for the current static tiles?
3) write adapter to replace chquerygen that stringifies the tile id
4) in retrospect, we don't need a res= level, just the tileid?
5) we'll need some metadata about valid tileids / resolutions i think? 480k tileids is a lot


annoyingly the below works but it also kills the server
i guess maybe we should do it in julia instead using our old hive directory stuff?
```sql
-- from 0 to max-3 where max=8
insert into function
file('chungus/kontur_export/{_partition_id}/kontur_export.parquet') -- /tile_id={_partition_id}/part0.parquet')
partition by concat('res=', res, '/tile_id=', tile_id)
select any(target) res, any(substring(lower(hex(h3ToParent(h3, target))),2)) tile_id, h3ToParent(h3, toUInt8(target+4)) index, sum(population) value from public_kontur_population_20231101
 -- 8 is max res of base data, 4 is our differential, +1 because end is excluded
array join range(0,toUInt8(8-4 + 1)) as target
group by index
order by index
settings max_threads=4
```
