import {MapboxOverlay} from '@deck.gl/mapbox'
import {TileLayer, H3HexagonLayer} from '@deck.gl/geo-layers'
import {BitmapLayer} from '@deck.gl/layers'
import maplibregl from 'maplibre-gl'
import * as d3 from 'd3'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as observablehq from './vendor/observablehq' // from https://observablehq.com/@d3/color-legend
import * as aq from 'arquero'
import * as h3 from 'h3-js'

const start_pos = {...{x: 7.27, y: 43.7, z: 10}, ...Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)))}
const map = new maplibregl.Map({
    container: 'map',
    style: `https://api.maptiler.com/maps/toner-v2/style.json?key=${window.location.hostname == 'localhost' ? 'Y4leWPnhJFGnTFFk1cru' : 'L7Sd3jHa1AR1dtyLCTgq'}`, // only authorised for localhost / o.blanthorn.com
    center: [start_pos.x, start_pos.y],
    zoom: start_pos.z,
    maxZoom: 18,
    minZoom: 1,
    bearing: 0,
    pitch: 0,
    maxBounds: [[-45, 0], [70, 75]], // WSEN // bounds restriced to europe + canary islands
})

let METADATA
async function getMetadata() {
    if (!METADATA) {
        METADATA = await (await fetch(`data/JRC_POPULATION_2018_H3_by_rnd/meta.json`)).json()
    }
    return METADATA
}

const colourRamp = d3.scaleSequential(d3.interpolateSpectral).domain([0,1])

/* convert from "rgba(r,g,b,a)" string to [r,g,b] */
// const getColour = v => Object.values(d3.color(colourRamp(v))).slice(0,-1)
const getColour = v => [...Object.values(d3.color(colourRamp(v))).slice(0,-1), Math.sqrt(v)*255] // with v as alpha too
let reloadNum = 0
const getHexData = (dfo) => new H3HexagonLayer({
    id: 'H3HexagonLayer',
    ish3: true,
    data: dfo,
    extruded: false,
    stroked: false,
    getHexagon: d => d.index,
    getFillColor: d => getColour(d.value),
    getElevation: d => (1-d.value)*1000,
    elevationScale: 20,
    pickable: true
})

const getHexData2 = (f) => new H3HexagonLayer({
    id: 'H3HexagonLayer',
    ish3: true,
    data: f(),
    extruded: false,
    stroked: false,
    getHexagon: d => d.index,
    getFillColor: d => getColour(d.value),
    getElevation: d => (1-d.value)*1000,
    elevationScale: 20,
    pickable: true
})


const getHighlightData = (df) => new H3HexagonLayer({
    id: 'selectedHex',
    ish3: true,
    data: df.objects(),
    extruded: false,
    stroked: false,
    getHexagon: d => d.index,
    getFillColor: d => [0, 255, 0, 100],
    pickable: true
})

function getTooltip({object}) {
    const toDivs = kv => {
        return `<div>${kv[0]}: ${typeof(kv[1]) == "number" ? parseFloat(kv[1].toPrecision(3)) : kv[1]}</div>` // parseFloat is a hack to bin scientific notation
    }
    return object && {
        // html: `<div>${(object.value).toPrecision(2)}</div>`,
        html: `${lastDensity !== undefined ? "<div>density: " + lastDensity + " population: " + lastPop + "</div>" : ""} ${Object.entries(object).map(toDivs).join(" ")}`,
        style: {
            backgroundColor: '#fff',
            fontFamily: 'sans-serif',
            fontSize: '0.8em',
            padding: '0.5em',
            // fontColor: 'black',
        }
    }
}
// df.derive({h3_5: aq.escape(d => h3.cellToParent(d.index, 5))}).groupby('h3_5').rollup({value: d => ag.op.mean(d.value)}).objects() // todo: aggregate at sensible zoom level. with some occlusion culling? aq.addFunction is roughly just as slow so don't bother
function human(number){
    return parseFloat(number.toPrecision(3)).toLocaleString()
}

let lastDensity
let lastLandDensity
let lastPop
let lastInfo
const mapOverlay = new MapboxOverlay({
    interleaved: false,
    onClick: (info, event) => makeHighlight(info, undefined),
    getTooltip,
})

function makeHighlight(info, force_radius){
    lastInfo = info ?? lastInfo
    if (info.layer == null) {
        return
    }
    if (info.layer.id === 'selectedHex') {
        mapOverlay.setProps({layers:[current_layers.filter(layer=>layer.id != 'selectedHex')]})
    }
    if (info.layer.props.ish3) {// && info.layer.id === 'H3HexagonLayer') {
        const radius = force_radius ?? document.getElementById("desired_radius").value
        const parents = new Set(h3.gridDisk(info.object.index, radius).map(ind => h3.cellToParent(ind, 3))) // work out which tiles to look at
        let filterTable = aq.table({index: h3.gridDisk(info.object.index, radius)})
        let dt = aq.from(Array.from(parents).map(p=>data_chunks.get(`${h3.getResolution(info.object.index)},${p}`)).flat().filter(x=>x!==undefined)).semijoin(filterTable, 'index') // extract data relevant to those tiles
        // validated: for all of UK, this gives us 2945 per km^2, which agrees with our previous work
        dt = dt.orderby('real_value').derive({cumsum: aq.rolling(d => op.sum(d.real_value))}) // get cumulative sum
            .derive({quantile: d => d.cumsum / op.sum(d.real_value)}) // normalise to get quantiles
            .derive({median_dist: d => aq.op.abs(d.quantile - 0.5)}) // get distance to median
            .orderby('median_dist') // sort by it
        window.dt = dt
        lastDensity = dt.get('real_value', 0) * 9 / h3.getResolution(dt.get('index', 0))
        lastLandDensity = dt.rollup({median: d => aq.op.median(d.real_value)}).get('median') * 9 / h3.getResolution(dt.get('index', 0))
        lastPop = dt.rollup({total: d => aq.op.mean(d.real_value)}).get('total') * dt.size * h3.getHexagonAreaAvg(h3.getResolution(dt.get('index', 0)), 'km2')
        document.getElementById("results_text").innerHTML = `
            <p>Approx radius: ${human(h3.getHexagonEdgeLengthAvg(h3.getResolution(dt.get('index', 0)), 'km') * 2 * radius + 1)} km </p>
            ${h3.getResolution(dt.get('index', 0)) == 9 ? "" : "<h3><b>Warning:</b> the numbers are broken at this zoom level, please " + (LOW_DATA ? "reload the page and allow high resolution data" : "zoom to ~approx region level and click again") + "</h3>"}
            <p>Median population density weighted by population: <b>${human(lastDensity)}</b> / km^2                                </p>
            <p>Median population density weighted by populated land area: <b>${human(lastLandDensity)}</b> / km^2                     </p>
            <p>Total population: <b>${human(lastPop)}</b>                                                                          </p>
            `
        document.getElementById("settings").show()
        mapOverlay.setProps({layers:[current_layers, getHighlightData(dt)]})
        // hexagon diameter = 2x edge length => distance k -> 1 + k*edge_length*2
        // agrees with tom forth pop around point numbers :D
        // maybe worth swapping to https://human-settlement.emergency.copernicus.eu/ghs_pop2023.php anyway

    }
}

map.addControl(mapOverlay)
map.addControl(new maplibregl.NavigationControl())

document.getElementById("desired_radius").addEventListener("sl-change", e => {
    if (lastInfo == undefined) {
        return
    }
    const radius = e.target.value
    makeHighlight(lastInfo, radius)
})

let LOW_DATA = false

const what2grab = () => {
    let res, disk
    const z = Math.floor(map.getZoom())
    if (z < 6) {
        res = 5
        disk = 14
    } else if (z < 8) {
        // res = 7
        // disk = 10
        res = 9
        disk = 2
    } else if (z < 100) {
        res = 9
        disk = 1
    }
    if (LOW_DATA) {
        res = Math.min(res, 7)
    }
    return {res, disk}
}

const choochoo = new TileLayer({
    id: 'OpenRailwayMapLayer',
    data: 'https://tiles.openrailwaymap.org/maxspeed/{z}/{x}/{y}.png',
    maxZoom: 19,
    minZoom: 0,

    renderSubLayers: props => {
        const {boundingBox} = props.tile;

        return new BitmapLayer(props, {
            data: null,
            image: props.data,
            bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]]
        })
    },
    pickable: false
})


let PARENTS = []
const data_chunks = new Map();
let current_layers = []
const ALERT = document.getElementById("zoom-in-please")
const MIN_ZOOM = navigator.userAgent.includes("Mobi") ? (navigator.userAgent.includes("Safari") ? 12 : 10) : 2
const IS_MOBILE = navigator.userAgent.includes("Mobi")
let LOW_DATA_ASKED = false
const update = async () => {
    if (IS_MOBILE && !LOW_DATA_ASKED && !LOW_DATA) {
        // use a dialog to ask user if they want to use LOW_DATA or not
        if (!window.confirm("Phone detected: click 'OK' to use high resolution data (~300MB per session) or click 'cancel' to use low resolution data (~50MB per session)")) {
            LOW_DATA = true
        }
        LOW_DATA_ASKED = true
    }
    if(map.getZoom() < MIN_ZOOM) {
        try {
            ALERT.toast()
        } catch(e) {
            ALERT.open = true
        }
        return
    }
    ALERT.open = false

    const pos = map.getCenter()
    const centreCell = h3.latLngToCell(pos.lat,pos.lng,3)
    const g = what2grab()
    const s2 = h3.gridDisk(centreCell, g.disk) // why did i call it s2? that's the google index
    const meta = await getMetadata()
    const s = []
    for (const i of s2) {
        if ((meta.valid_parents[g.res].includes(i))){
            s.push(i)
        }
    }
    if (PARENTS.sort().join() == s.sort().join()) {
        return
    }
    lastInfo = undefined // invalidate cache

    function unreliable_sort(a) {
        try {
            return a.sort((l,r) => h3.gridDistance(l,centreCell) - h3.gridDistance(r,centreCell)).slice(0,250)
        } catch(e) {
            console.warn(e)
            return a
        }
    }
    
    const max_layers = 250 // deck doesn't like more than 255
    const mini_s = unreliable_sort(s).slice(0,250)
    PARENTS = mini_s

    const layers = (await Promise.all(mini_s.map(async i => {
        const key = `${g.res},${i}`
        if (!(data_chunks.has(key))) {
            const url = `data/JRC_POPULATION_2018_H3_by_rnd/res=${g.res}/h3_3=${i}/part0.arrow`
            const f = await fetch(url)
            if (f.status == 404) {
                return undefined
            }
            data_chunks.set(key, (await aq.loadArrow(url)).objects())
        }

        return new H3HexagonLayer({
            id: key,
            ish3: true,
            data: data_chunks.get(key),
            extruded: false,
            stroked: false,
            getHexagon: d => d.index,
            getFillColor: d => getColour(d.value),
            getElevation: d => (1-d.value)*1000,
            elevationScale: 20,
            pickable: true
        })
    }))).filter(x=>x!=undefined)

    if (params.get('trains') !== null){
        layers.push(choochoo)
    }

    mapOverlay.setProps({layers})
    current_layers = layers

    // gc
    const s_res = mini_s.map(i => `${g.res},${i}`)
    for (const k of data_chunks.keys()) {
        if (!(s_res.includes(k))) {
            data_chunks.delete(k)
        }
    }
}
update()


window.d3 = d3
window.observablehq = observablehq
window.aq = aq
window.h3 = h3
window.update = update

const params = new URLSearchParams(window.location.search)
const l = document.getElementById("attribution")
l.innerText = "© " + [params.get('c'), "Eurostat", "MapTiler", "OpenStreetMap contributors", params.get('trains') !== null ? "OpenRailwayMap" : null].filter(x=>x !== null).join(" © ")
getMetadata().then(d => {
    const fmt = v => d['scale'][Object.keys(d['scale']).map(x => [x, Math.abs(x - v)]).sort((l,r)=>l[1] - r[1])[0][0]].toLocaleString()
    const legend = observablehq.legend({color: colourRamp, title: "Population per km^2", tickFormat: fmt})
    l.insertBefore(legend, l.firstChild)
})

map.on('moveend', () => {
    const pos = map.getCenter()
    const z = map.getZoom()
    window.location.hash = `x=${pos.lng}&y=${pos.lat}&z=${z}`
    setTimeout(x => {
        const npos = map.getCenter()
        if ((pos.lng == npos.lng) && (pos.lat == npos.lat)) {
            console.log("updating")
            update()
        }
    }, 1000)
})

// nicked from https://phuoc.ng/collection/html-dom/change-the-favicon-dynamically-based-on-user-color-scheme-preference/
const setFavicon = () => {
        const favicon = document.querySelector('link[rel="icon"]');
        favicon.href = (window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'cow.svg' : 'cow-light.svg'
}
setFavicon()
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setFavicon)
