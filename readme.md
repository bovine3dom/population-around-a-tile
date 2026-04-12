# Population around a tile

<a href="https://o.blanthorn.com/population-around-a-tile/map/">Visit the map here</a>

A 'simple' data vis tool using MapLibre GL and deck.gl to display a pre-computed population hex grid itself tiled by hexes and served from a bog-standard HTTP server, or optionally from ClickHouse, with a quantile-based legend that updates as you move.

<p align="center">
<video src="https://github.com/user-attachments/assets/6950d10d-1d51-4414-bc1e-9d1124f519da">demo video covering jumping to cities, getting population graphs, changing colour scheme etc</video>
</p>

# How to run

Prerequisites: bun. A web browser. A couple of gigs of space (sticking it on a partition with full disk compression is highly recommended)

0. `git clone` - this might take a while as there are 500k files
1. `bun install`
2. `bun serve&; bun watch`, open localhost:1983

If you have updated src/app.ts, remember to run `bun build` and commit map/src.js or GitHub pages won't update anything.


# h3 tile layer

somehow foursquare managed to trademark 'hex tiles', absolutely insane. i wonder which regular polygon they'll go for next. so we need to think of a name. {6}-tiles maybe which as a bonus is totally obtuse. but honestly the trademark is so clearly unjustifiable that we should genericise it like hoover.

anyway need to formalise the format spec etc.

at the moment it's /tile_id={string_index}/part0.arrow, where part0.arrow is an uncompressed arrow file of index: uint64, value: float 0-1, optional weight: float 0-1, and all index values are of the same h3 resolution and are less than or equal to the resolution of the string_index

because there are so many files, but some tiles are missing, we use a bloom filter to reduce the number of 404s. you can update it by running `bun scripts/make_bloom.js`

todo:

- extract tile layer to a library?
