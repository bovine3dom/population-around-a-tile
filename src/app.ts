import { MapboxOverlay } from '@deck.gl/mapbox'
import { TileLayer, H3HexagonLayer } from '@deck.gl/geo-layers'
import { BitmapLayer } from '@deck.gl/layers'
import maplibregl from 'maplibre-gl'
import * as d3 from 'd3'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as observablehq from './vendor/observablehq'
import * as aq from 'arquero'
import * as h3 from 'h3-js'
import { ArrowH3TileLayer, tileCache, type ArrowH3TileLayerProps } from './ArrowH3TileLayer'

const username = 'public_web';
const password = 'a2hkayBzZGlsO2RqIHNsayBsYWpzZCBmbGogc2Rsa2og';
const ch_endpoint = "https://compute.olie.science/ch";


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

// Shared colour ramp — domain updated dynamically from loaded tile values
const colourRamp = d3.scaleSequential(d3.interpolateSpectral).domain([0, 1])

const getColour = (v: number): [number, number, number, number] => {
  const c = d3.color(colourRamp(v))!
  const rgb = c.formatRgb().match(/[\d.]+/g)!.map(Number)
  return [rgb[0], rgb[1], rgb[2], Math.sqrt(v) * 255]
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
  const query = `
      select h3ToParent(h3, ${resolution + 2}) index, sum(population) value
      from public_kontur_population_20231101
      where h3ToParent(h3, ${resolution}) = reinterpretAsUInt64(reverse(unhex('${h3Index}')))
      group by index
  `
  return chQuery(query)
}

// ---- Legend ----
let legendElement: SVGSVGElement | null = null
const attributionEl = document.getElementById('attribution')!

function updateLegend() {
  const samples = h3Layer.getSampleValues(100_000)
  if (samples.length === 0) return

  samples.sort((a, b) => a - b)

  // Compute quantile-based domain: use 0.01 and 0.99 quantiles to avoid extreme outliers
  const q01 = d3.quantile(samples, 0.01) ?? 0
  const q99 = d3.quantile(samples, 0.99) ?? 1
  colourRamp.domain([q01, q99])

  // Re-render legend
  getMetadata().then((d) => {
    const fmt = (v: number) =>
      d['scale'][
        (Object.keys(d['scale'])
          .map((x) => [x, Math.abs(Number(x) - v)] as [string, number])
          .sort((a, b) => a[1] - b[1])[0] as [string, number])[0]
      ].toLocaleString()

    if (legendElement) {
      legendElement.remove()
    }
    legendElement = observablehq.legend({ color: colourRamp, title: 'Population per km^2', tickFormat: fmt })
    attributionEl.insertBefore(legendElement, attributionEl.firstChild)
  })

  // Force re-render of hex layers by updating the colorDomain trigger
  mapOverlay.setProps({
    layers: [new ArrowH3TileLayer({
      id: 'H3TileLayer',
      // @ts-expect-error custom data function
      data: chquerygen,
      pickable: true,
      getFillColor: getColour,
      colorDomain: [q01, q99],
      onDataChange: (layer: ArrowH3TileLayer) => {
        console.log(`[datachange] tiles loaded: ${tileCache.size}`)
        updateLegend()
      },
    })],
  })
}

// ---- Click / median ----
let lastDensity: number | undefined
let lastLandDensity: number | undefined
let lastPop: number | undefined
let lastInfo: any

const h3Layer = new ArrowH3TileLayer({
  id: 'H3TileLayer',
  // @ts-expect-error custom data function
  data: chquerygen,
  pickable: true,
  getFillColor: getColour,
  colorDomain: [0, 1],
  onDataChange: () => {
    console.log(`[datachange] tiles loaded: ${tileCache.size}`)
    updateLegend()
  },
})

const mapOverlay = new MapboxOverlay({
  interleaved: false,
  onClick: (info: any) => makeHighlight(info, undefined),
  getTooltip: ({ object }: { object?: any }) => {
    if (!object) return null
    const toDivs = (kv: [string, unknown]): string => {
      return `<div>${kv[0]}: ${typeof kv[1] == 'number' ? parseFloat(kv[1].toPrecision(3)) : kv[1]}</div>`
    }
    return {
      html: `${lastDensity !== undefined ? '<div>density: ' + lastDensity + ' population: ' + lastPop + '</div>' : ''} ${Object.entries(object).map(toDivs).join(' ')}`,
      style: {
        backgroundColor: '#fff',
        fontFamily: 'sans-serif',
        fontSize: '0.8em',
        padding: '0.5em',
      },
    }
  },
  layers: [h3Layer],
})

const getHighlightData = (df: any) =>
  new H3HexagonLayer({
    id: 'selectedHex',
    ish3: true,
    data: df.objects(),
    extruded: false,
    stroked: false,
    getHexagon: (d: any) => d.index,
    getFillColor: () => [0, 255, 0, 100] as [number, number, number, number],
    pickable: true,
  })

function makeHighlight(info: any | undefined, force_radius: number | undefined) {
  console.log('[makeHighlight]', {
    info,
    layerId: info?.layer?.id,
    objectIndex: info?.object?.index,
    tileId: info?.sourceTile?.id,
    cacheSize: tileCache.size,
    cacheKeys: [...tileCache.keys()].slice(0, 5),
  })

  lastInfo = info ?? lastInfo
  if (info?.layer == null) {
    return
  }
  if (info.layer.id === 'selectedHex') {
    mapOverlay.setProps({
      layers: [h3Layer],
    })
    return
  }
  if (info.layer.props.ish3) {
    const radius = force_radius ?? Number((document.getElementById('desired_radius') as HTMLInputElement).value)
    const clickedIndex = info.object.index
    console.log('[makeHighlight] clicked index:', clickedIndex, 'radius:', radius)
    console.log('[makeHighlight] resolution:', h3.getResolution(clickedIndex))

    // Get all matching cells from loaded tiles
    const matchedTiles = h3Layer.getCellsInRadius(clickedIndex, radius)
    console.log('[makeHighlight] matched tile groups:', matchedTiles.length)
    let totalMatched = 0
    for (const g of matchedTiles) {
      totalMatched += g.index.length
    }
    console.log('[makeHighlight] total matched cells:', totalMatched)

    if (totalMatched === 0) {
      console.warn('[makeHighlight] No matching cells found. Data may not be loaded yet.')
      return
    }

    // Build an arquero table from matched data
    const allIndices: string[] = []
    const allValues: number[] = []
    for (const g of matchedTiles) {
      allIndices.push(...g.index)
      allValues.push(...g.value)
    }

    let dt = aq.table({ index: allIndices, value: allValues })

    // Deduplicate by index (take max value if duplicated across tile boundaries)
    dt = dt.groupby('index').rollup({ value: (d: any) => aq.op.max(d.value) })

    console.log('[makeHighlight] deduplicated table size:', dt.size)

    dt = dt
      .orderby('value')
      .derive({ cumsum: aq.rolling((d: any) => aq.op.sum(d.value)) })
      .derive({ quantile: (d: any) => d.cumsum / aq.op.sum(d.value) })
      .derive({
        median_dist: (d: any) => aq.op.abs(d.quantile - 0.5),
        q75_dist: (d: any) => aq.op.abs(d.quantile - 0.75),
        q25_dist: (d: any) => aq.op.abs(d.quantile - 0.25),
      })
      .orderby('median_dist')
    ;(window as any).dt = dt

    const res = h3.getResolution(dt.get('index', 0) as string)
    const areaKm2 = h3.getHexagonAreaAvg(res, 'km2')
    const scale = 1 / areaKm2  // convert to per km²

    lastDensity = (dt.get('value', 0) as number) * scale
    const last75Density = (dt.orderby('q75_dist').get('value', 0) as number) * scale
    const last25Density = (dt.orderby('q25_dist').get('value', 0) as number) * scale
    lastLandDensity = (dt.rollup({ median: (d: any) => aq.op.median(d.value) }).get('median') as number) * scale

    lastPop = Number(dt.rollup({ total: (d: any) => aq.op.sum(d.value) }).get('total'))

    document.getElementById('results_text')!.innerHTML = `
            <p>Approx radius: ${human(h3.getHexagonEdgeLengthAvg(res, 'km') * 2 * radius + 1)} km </p>
            <p>Median population density weighted by population: <b>${human(lastDensity)}</b> / km², 75th percentile: <b>${human(last75Density)}</b> / km², 25th percentile: <b>${human(last25Density)}</b> / km² </p>
            <p>Median population density weighted by populated land area: <b>${human(lastLandDensity)}</b> / km²                   </p>
            <p>Total population: <b>${human(lastPop)} ${res == 5 ? '<sl-tag variant="warning"><sl-icon name="exclamation-triangle"></sl-icon>&nbsp; ~2x overestimate at this zoom level</sl-tag>' : ''}</b>                                                                          </p>
            `
    ;(document.getElementById('settings') as any).show()
    mapOverlay.setProps({ layers: [h3Layer, getHighlightData(dt)] })
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

// ---- Attribution ----
const params = new URLSearchParams(window.location.search)
attributionEl.innerText =
  '© ' +
  [params.get('c'), 'Eurostat', 'MapTiler', 'OpenStreetMap contributors', params.get('trains') !== null ? 'OpenRailwayMap' : null]
    .filter((x) => x !== null)
    .join(' © ')

// ---- Hash updates ----
map.on('moveend', () => {
  const pos = map.getCenter()
  const z = map.getZoom()
  window.location.hash = `x=${pos.lng}&y=${pos.lat}&z=${z}`
})

// ---- Favicon ----
const setFavicon = () => {
  const favicon = document.querySelector('link[rel="icon"]') as HTMLLinkElement
  favicon.href = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'cow.svg' : 'cow-light.svg'
}
setFavicon()
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setFavicon)
