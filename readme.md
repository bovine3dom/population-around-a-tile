# Population around a tile

https://o.blanthorn.com/population-around-a-tile/map/

A 'simple' data vis tool using MapLibre GL and deck.gl to display a pre-computed population hex grid itself tiled by hexes and served from a bog-standard HTTP server.

<p align="center">
<img src="promo/demo.png" alt="An astonishingly beautiful map Nice coloured by population density, with the central area highlighted and details of the population density displayed (it's about 12k/km2)">
</p>

# How to run

Prerequisites: yarn. A web browser

0. `git clone`
1. `yarn install`
2. `yarn serve&; yarn watch`, open localhost:1983

If you have updated src/app.js, remember to run `yarn build` and commit map/src.js or GitHub pages won't commit anything.
