import { MapboxOverlay } from '@deck.gl/mapbox'
import { TileLayer, H3HexagonLayer } from '@deck.gl/geo-layers'
import { BitmapLayer } from '@deck.gl/layers'
import maplibregl from 'maplibre-gl'
import * as d3 from 'd3'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as observablehq from './vendor/observablehq'
import * as aq from 'arquero'
import * as h3 from 'h3-js'
import { ArrowH3TileLayer } from './ArrowH3TileLayer'

declare const username: string
declare const password: string
declare const ch_endpoint: string

interface StartPos {
  x: number
  y: number
  z: number
}

const start_pos: StartPos = {
  ...{ x: 7.27, y: 43.7, z: 10 },
  ...Object.fromEntries(new URLSearchParams(window.location.hash.slice(1))),
}

const map = new maplibregl.Map({
  container: 'map',
  style: `https://api.maptiler.com/maps/toner-v2/style.json?key=${window.location.hostname == 'localhost' ? 'Y4leWPnhJFGnTFFk1cru' : 'L7Sd3jHa1AR1dtyLCTgq'}`,
  center: [start_pos.x, start_pos.y],
  zoom: start_pos.z,
  maxZoom: 18,
  minZoom: 1,
  bearing: 0,
  pitch: 0,
  maxBounds: [
    [-45, 0],
    [70, 75],
  ],
})

interface Metadata {
  scale: Record<string, number>
}

let METADATA: Metadata | undefined
async function getMetadata(): Promise<Metadata> {
  if (!METADATA) {
    METADATA = await (await fetch(`data/JRC_POPULATION_2018_H3_by_rnd/meta.json`)).json()
  }
  return METADATA!
}

const colourRamp = d3.scaleSequential(d3.interpolateSpectral).domain([0, 1])

const getColour = (v: number): [number, number, number, number] => {
  const c = d3.color(colourRamp(v))!
  const rgb = c.formatRgb().match(/[\d.]+/g)!.map(Number)
  return [rgb[0], rgb[1], rgb[2], Math.sqrt(v) * 255]
}

let reloadNum = 0

interface HexData {
  index: string
  value: number
}

const getHexData = (dfo: HexData[]) =>
  new H3HexagonLayer({
    id: 'H3HexagonLayer',
    ish3: true,
    data: dfo,
    extruded: false,
    stroked: false,
    getHexagon: (d: HexData) => d.index,
    getFillColor: (d: HexData) => getColour(d.value),
    getElevation: (d: HexData) => (1 - d.value) * 1000,
    elevationScale: 20,
    pickable: true,
  })

const getHexData2 = (f: () => HexData[]) =>
  new H3HexagonLayer({
    id: 'H3HexagonLayer',
    ish3: true,
    data: f(),
    extruded: false,
    stroked: false,
    getHexagon: (d: HexData) => d.index,
    getFillColor: (d: HexData) => getColour(d.value),
    getElevation: (d: HexData) => (1 - d.value) * 1000,
    elevationScale: 20,
    pickable: true,
  })

const getHighlightData = (df: any) =>
  new H3HexagonLayer({
    id: 'selectedHex',
    ish3: true,
    data: df.objects(),
    extruded: false,
    stroked: false,
    getHexagon: (d: HexData) => d.index,
    getFillColor: () => [0, 255, 0, 100] as [number, number, number, number],
    pickable: true,
  })

function getTooltip({ object }: { object?: any }) {
  const toDivs = (kv: [string, unknown]): string => {
    return `<div>${kv[0]}: ${typeof kv[1] == 'number' ? parseFloat(kv[1].toPrecision(3)) : kv[1]}</div>`
  }
  return (
    object && {
      html: `${lastDensity !== undefined ? '<div>density: ' + lastDensity + ' population: ' + lastPop + '</div>' : ''} ${Object.entries(object).map(toDivs).join(' ')}`,
      style: {
        backgroundColor: '#fff',
        fontFamily: 'sans-serif',
        fontSize: '0.8em',
        padding: '0.5em',
      },
    }
  )
}

function human(number: number): string {
  return parseFloat(number.toPrecision(2)).toLocaleString()
}

function chQuery(query: string): Promise<Response> {
  return fetch(`${ch_endpoint}/?query=${encodeURIComponent(query + " format arrow settings output_format_arrow_compression_method = 'none'")}`, {
    headers: new Headers({
      Authorization: `Basic ${btoa(username + ':' + password)}`,
    }),
  })
}

const chquerygen = ({ h3Index, resolution }: { h3Index: string; resolution: number }) => {
  return chQuery(`
        select avg(crow_km) value, geoToH3(stop_lat, stop_lon, ${resolution + 3}) index
        --select count()+.000001 value, geoToH3(stop_lat, stop_lon, ${resolution + 2}) index
        from transitous_everything_20260117_stop_statistics_unmerged3
        where h3ToParent(index, ${resolution}) = reinterpretAsUInt64(reverse(unhex('${h3Index}')))
        group by index
    `)
}

let lastDensity: number | undefined
let lastLandDensity: number | undefined
let lastPop: number | undefined
let lastInfo: any

const data_chunks: Map<string, any[]> = new Map()
let current_layers: any[] = []

const mapOverlay = new MapboxOverlay({
  interleaved: false,
  onClick: (info: any, event: any) => makeHighlight(info, undefined),
  getTooltip: getTooltip as any,
  layers: [
    new ArrowH3TileLayer({
      id: 'H3TileLayer',
      // @ts-expect-error custom data function
      data: chquerygen,
      pickable: true,
    }),
  ],
})

interface HighlightInfo {
  layer: { id: string; props: { ish3?: boolean } } | null
  object: { index: string }
}

function makeHighlight(info: HighlightInfo | undefined, force_radius: number | undefined) {
  lastInfo = info ?? lastInfo
  if (info?.layer == null) {
    return
  }
  if (info.layer.id === 'selectedHex') {
    mapOverlay.setProps({
      layers: [current_layers.filter((layer: any) => layer.id != 'selectedHex')],
    })
  }
  if (info.layer.props.ish3) {
    const radius = force_radius ?? Number((document.getElementById('desired_radius') as HTMLInputElement).value)
    const res = h3.getResolution(info.object.index)
    const parents = new Set(
      h3
        .gridDisk(info.object.index, radius)
        .map((ind) => h3.cellToParent(ind, res2parent(res))),
    )
    let filterTable = aq.table({ index: h3.gridDisk(info.object.index, radius) })
    let dt = aq
      .from(
        Array.from(parents)
          .map((p) => data_chunks.get(`${h3.getResolution(info.object.index)},${p}`))
          .flat()
          .filter((x) => x !== undefined),
      )
      .semijoin(filterTable, 'index')
    dt = dt
      .orderby('real_value')
      .derive({ cumsum: aq.rolling((d: any) => aq.op.sum(d.real_value)) })
      .derive({ quantile: (d: any) => d.cumsum / aq.op.sum(d.real_value) })
      .derive({
        median_dist: (d: any) => aq.op.abs(d.quantile - 0.5),
        q75_dist: (d: any) => aq.op.abs(d.quantile - 0.75),
        q25_dist: (d: any) => aq.op.abs(d.quantile - 0.25),
      })
      .orderby('median_dist')
    ;(window as any).dt = dt
    lastDensity = (dt.get('real_value', 0) as number) * 9 / h3.getResolution(dt.get('index', 0) as string)
    const last75Density = (dt.orderby('q75_dist').get('real_value', 0) as number) * 9 / h3.getResolution(dt.get('index', 0) as string)
    const last25Density = (dt.orderby('q25_dist').get('real_value', 0) as number) * 9 / h3.getResolution(dt.get('index', 0) as string)
    lastLandDensity =
      (dt.rollup({ median: (d: any) => aq.op.median(d.real_value) }).get('median') as number) *
      9 /
      h3.getResolution(dt.get('index', 0) as string)

    if ('population' in dt.columnNames()) {
      lastPop = Number(
        dt.rollup({ total: (d: any) => aq.op.sum(d.population) }).get('total'),
      )
    } else {
      lastPop =
        (dt.rollup({ total: (d: any) => aq.op.mean(d.real_value) }).get('total') as number) *
        dt.size *
        h3.getHexagonAreaAvg(h3.getResolution(dt.get('index', 0) as string), 'km2')
    }
    document.getElementById('results_text')!.innerHTML = `
            <p>Approx radius: ${human(h3.getHexagonEdgeLengthAvg(h3.getResolution(dt.get('index', 0) as string), 'km') * 2 * radius + 1)} km </p>
            <p>Median population density weighted by population: <b>${human(lastDensity)}</b> / km², 75th percentile: <b>${human(last75Density)}</b> / km², 25th percentile: <b>${human(last25Density)}</b> / km² </p>
            <p>Median population density weighted by populated land area: <b>${human(lastLandDensity)}</b> / km²                   </p>
            <p>Total population: <b>${human(lastPop)} ${res == 5 ? '<sl-tag variant="warning"><sl-icon name="exclamation-triangle"></sl-icon>&nbsp; ~2x overestimate at this zoom level</sl-tag>' : ''}</b>                                                                          </p>
            `
    ;(document.getElementById('settings') as any).show()
    current_layers = [new ArrowH3TileLayer({
      id: 'H3TileLayer',
      // @ts-expect-error custom data function
      data: chquerygen,
      pickable: true,
    })]
    mapOverlay.setProps({ layers: [current_layers, getHighlightData(dt)] })
  }
}

map.addControl(mapOverlay)
map.addControl(new maplibregl.NavigationControl())

document.getElementById('desired_radius')!.addEventListener('sl-change', (e: Event) => {
  if (lastInfo == undefined) {
    return
  }
  const radius = Number((e.target as HTMLInputElement).value)
  makeHighlight(lastInfo, radius)
})

let LOW_DATA = false
interface What2Grab {
  res: number
  disk: number
  parent_res: number
}

const what2grab = (): What2Grab => {
  let res: number, disk: number
  const z = Math.floor(map.getZoom())
  if (z < 6) {
    res = 5
    disk = 5
  } else if (z < 7) {
    res = 7
    disk = 6
  } else if (z < 8) {
    res = 7
    disk = 4
  } else if (z < 100) {
    res = 9
    disk = 1
  } else {
    res = 9
    disk = 1
  }
  if (LOW_DATA) {
    res = Math.max(Math.min(res - 2, 7), 5)
  }
  return { res, disk, parent_res: res2parent(res) }
}

const res2parent = (res: number): number => {
  if (res == 5) {
    return 1
  } else if (res == 7) {
    return 3
  } else if (res == 9) {
    return 3
  }
  throw new Error('unknown parent resolution')
}

const choochoo = new TileLayer({
  id: 'OpenRailwayMapLayer',
  data: 'https://tiles.openrailwaymap.org/maxspeed/{z}/{x}/{y}.png',
  maxZoom: 19,
  minZoom: 0,

  renderSubLayers: (props: any) => {
    const { boundingBox } = props.tile

    return new BitmapLayer(props, {
      data: undefined,
      image: props.data,
      bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]],
    })
  },
  pickable: false,
})

;(window as any).d3 = d3
;(window as any).observablehq = observablehq
;(window as any).aq = aq
;(window as any).h3 = h3

const params = new URLSearchParams(window.location.search)
const l = document.getElementById('attribution')!
l.innerText =
  '© ' +
  [params.get('c'), 'Eurostat', 'MapTiler', 'OpenStreetMap contributors', params.get('trains') !== null ? 'OpenRailwayMap' : null]
    .filter((x) => x !== null)
    .join(' © ')

getMetadata().then((d) => {
  const fmt = (v: number) =>
    d['scale'][
      (Object.keys(d['scale'])
        .map((x) => [x, Math.abs(Number(x) - v)] as [string, number])
        .sort((a, b) => a[1] - b[1])[0] as [string, number])[0]
    ].toLocaleString()
  const legend = observablehq.legend({ color: colourRamp, title: 'Population per km^2', tickFormat: fmt })
  l.insertBefore(legend, l.firstChild)
})

map.on('moveend', () => {
  const pos = map.getCenter()
  const z = map.getZoom()
  window.location.hash = `x=${pos.lng}&y=${pos.lat}&z=${z}`
  setTimeout((x) => {
    const npos = map.getCenter()
    if (pos.lng == npos.lng && pos.lat == npos.lat) {
      console.log('updating')
    }
  }, 1000)
})

const setFavicon = () => {
  const favicon = document.querySelector('link[rel="icon"]') as HTMLLinkElement
  favicon.href = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'cow.svg' : 'cow-light.svg'
}
setFavicon()
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setFavicon)
