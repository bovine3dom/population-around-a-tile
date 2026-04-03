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
// @ts-expect-error no types
import { Chart } from 'frappe-charts/dist/frappe-charts.esm'
import { findClosestCity } from './tiny-cities'
(window as any).findClosestCity = findClosestCity

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
let colourDomain: [number, number] = [0, 0]

const getColour = (v: number): [number, number, number, number] => {
  const c = d3.color(colourRamp(v))!
  const rgb = c.formatRgb().match(/[\d.]+/g)!.map(Number)
  // Normalise v for opacity: clamp to domain, then 0-1
  const [lo, hi] = colourDomain
  const normalised = lo === hi ? 0 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
  return [rgb[0], rgb[1], rgb[2], Math.sqrt(normalised) * 255]
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
      select h3ToParent(h3, least(${resolution + 4}, h3GetResolution(h3))) index, sum(population) value, sum(population) weight
      from public_kontur_population_20231101
      where h3ToParent(h3, ${resolution}) = reinterpretAsUInt64(reverse(unhex('${h3Index}')))
      group by index
  `
  return chQuery(query)
}

// ---- Legend ----
let legendElement: SVGSVGElement | null = null
const attributionEl = document.getElementById('attribution')!

// Throttled legend update: fires immediately, then waits 500ms before next call
let legendThrottleTimer: ReturnType<typeof setTimeout> | null = null

function throttledUpdateLegend() {
  if (legendThrottleTimer) return
  updateLegend()
  legendThrottleTimer = setTimeout(() => {
    legendThrottleTimer = null
  }, 500)
}

// Weighted quantile: sorts values by v, uses weights to find quantile positions
function weightedQuantile(values: number[], weights: number[], p: number): number {
  // Create index array and sort by values
  const idx = values.map((_, i) => i)
  idx.sort((a, b) => values[a] - values[b])

  let cumWeight = 0
  const totalWeight = weights.reduce((s, w) => s + w, 0)
  const target = p * totalWeight

  for (const i of idx) {
    cumWeight += weights[i]
    if (cumWeight >= target) {
      return values[i]
    }
  }
  return values[idx[idx.length - 1]]
}

function updateLegend() {
  const { values, weights } = h3Layer.getSampleValuesAndWeights(100_000)
  if (values.length === 0) return

  let q01: number, q99: number

  if (weights && weights.length === values.length) {
    // Weighted quantiles
    q01 = weightedQuantile(values, weights, 0.01)
    q99 = weightedQuantile(values, weights, 0.99)
  } else {
    // Unweighted
    values.sort((a, b) => a - b)
    q01 = d3.quantile(values, 0.01) ?? 0
    q99 = d3.quantile(values, 0.99) ?? 1
  }

  colourDomain = [q01, q99]
  colourRamp.domain(colourDomain)

  // Re-render legend
  const fmt = d3.format('.0f')

  if (legendElement) {
    legendElement.remove()
  }
  legendElement = observablehq.legend({ color: colourRamp, title: 'Population per km^2', tickFormat: fmt })
  attributionEl.insertBefore(legendElement, attributionEl.firstChild)

  // Force re-render of hex layers by updating the colorDomain trigger
  mapOverlay.setProps({
    layers: [new ArrowH3TileLayer({
      id: 'H3TileLayer',
      // @ts-expect-error custom data function
      data: chquerygen,
      pickable: true,
      getFillColor: getColour,
      colorDomain: [q01, q99],
      onDataChange: throttledUpdateLegend,
    })],
  })
}

// ---- Click / median ----
let lastDensity: number | undefined
let lastLandDensity: number | undefined
let lastPop: number | undefined
let lastInfo: any

// Chart state: array of { city, edgeKm, ringStats, centerValue }
let chartLocations: {
  city: string
  edgeKm: number
  ringStats: { distance: number; median: number; q25: number; q75: number; count: number }[]
  centerValue: number
  color: string
}[] = []

const COLORS = ['#ff69b4', '#ffa500', '#41c6ff', '#7cfc00', '#ff4500', '#9370db', '#00ced1', '#ffd700']

const h3Layer = new ArrowH3TileLayer({
  id: 'H3TileLayer',
  // @ts-expect-error custom data function
  data: chquerygen,
  pickable: true,
  getFillColor: getColour,
  colorDomain: [0, 1],
  onDataChange: throttledUpdateLegend,
})

// Capture shift state at mousedown time (before keyup can interfere)
let clickShiftState = false
document.addEventListener('mousedown', (e) => { clickShiftState = e.shiftKey })

const mapOverlay = new MapboxOverlay({
  interleaved: false,
  onClick: (info: any) => {
    makeHighlight(info, undefined, clickShiftState)
  },
  getTooltip: (info: any) => {
    if (info.index === undefined || !info.sourceTile?.content?.data) return null

    const idx = info.index
    const data = info.sourceTile.content.data
    const h3Index = typeof data.index[idx] === 'bigint' ? data.index[idx].toString(16) : data.index[idx]
    const value = data.value[idx]

    if (value === undefined) return null

    return {
      html: `${lastDensity !== undefined ? '<div>density: ' + lastDensity + ' population: ' + lastPop + '</div>' : ''}<div>index: ${h3Index}</div><div>value: ${typeof value == 'number' ? parseFloat(value.toPrecision(3)) : value}`,
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

function makeHighlight(info: any | undefined, force_radius: number | undefined, append = false) {
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
  // Accept clicks on any layer (not just ones with ish3 prop)
  if (info.layer.id === 'H3TileLayer') {
    const radius = force_radius ?? Number((document.getElementById('desired_radius') as HTMLInputElement).value)

    // Get the clicked H3 index from the tile content
    const clickedIndexBigInt = info.sourceTile?.content?.data?.index?.[info.index]
    if (clickedIndexBigInt === undefined) {
      console.warn('[makeHighlight] Could not find clicked H3 index')
      return
    }
    // Convert BigInt to hex string for h3-js
    const clickedIndex = typeof clickedIndexBigInt === 'bigint'
      ? clickedIndexBigInt.toString(16)
      : String(clickedIndexBigInt)

    // Get all matching cells from loaded tiles
    const matchedTiles = h3Layer.getCellsInRadius(clickedIndex, radius)
    let totalMatched = 0
    for (const g of matchedTiles) {
      totalMatched += g.index.length
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

    // Log density quantiles per hollow ring
    const ringStats: { distance: number; median: number; q25: number; q75: number; count: number }[] = []
    for (let d = 1; d <= radius; d++) {
      const ring = h3.gridRing(clickedIndex, d)
      if (ring.length === 0) continue

      // Find matching cells in this ring
      const ringSet = new Set(ring)
      const ringValues: number[] = []
      for (const g of matchedTiles) {
        for (let i = 0; i < g.index.length; i++) {
          if (ringSet.has(g.index[i])) {
            ringValues.push(g.value[i])
          }
        }
      }

      if (ringValues.length === 0) {
        ringStats.push({ distance: d, median: 0, q25: 0, q75: 0, count: 0 })
        continue
      }

      // Weighted quantiles for this ring
      const ringTable = aq.table({ value: ringValues })
        .orderby('value')
        .derive({ cumsum: aq.rolling((d: any) => aq.op.sum(d.value)) })
        .derive({ quantile: (d: any) => d.cumsum / aq.op.sum(d.value) })
        .derive({
          median_dist: (d: any) => aq.op.abs(d.quantile - 0.5),
          q75_dist: (d: any) => aq.op.abs(d.quantile - 0.75),
          q25_dist: (d: any) => aq.op.abs(d.quantile - 0.25),
        })

      const median = (ringTable.orderby('median_dist').get('value', 0) as number) * scale
      const q25 = (ringTable.orderby('q25_dist').get('value', 0) as number) * scale
      const q75 = (ringTable.orderby('q75_dist').get('value', 0) as number) * scale

      ringStats.push({ distance: d, median, q25, q75, count: ringValues.length })
    }

    console.log('[makeHighlight] ring density quantiles (pop-weighted, per km²):')
    console.table(ringStats)

    const edgeKm = h3.getHexagonEdgeLengthAvg(res, 'km')
    const centerLat = h3.cellToLatLng(clickedIndex)[0]
    const centerLon = h3.cellToLatLng(clickedIndex)[1]
    const cityLabel = findClosestCity(centerLat, centerLon)
    const centerValue = (dt.get('value', 0) as number) * scale

    // Build or append chart data
    if (append) {
      chartLocations.push({ city: cityLabel, edgeKm, ringStats, centerValue, color: COLORS[chartLocations.length % COLORS.length] })
    } else {
      chartLocations = [{ city: cityLabel, edgeKm, ringStats, centerValue, color: COLORS[0] }]
    }

    renderChart()

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

function renderChart() {
  if (chartLocations.length === 0) return

  // Build symmetric labels from the first location
  const first = chartLocations[0]
  const edgeKm = first.edgeKm
  const maxDist = first.ringStats.length > 0 ? first.ringStats[first.ringStats.length - 1].distance : 0

  const mirroredLabels: string[] = []
  for (let d = maxDist; d >= 1; d--) {
    mirroredLabels.push(`-${(d * edgeKm * 2).toFixed(1)}`)
  }
  mirroredLabels.push('0')
  for (let d = 1; d <= maxDist; d++) {
    mirroredLabels.push(`${(d * edgeKm * 2).toFixed(1)}`)
  }

  const datasets: any[] = []

  if (chartLocations.length === 1) {
    // Single city: show median, 25th, 75th
    const loc = chartLocations[0]
    const medianVals: number[] = []
    const q25Vals: number[] = []
    const q75Vals: number[] = []

    for (let d = maxDist; d >= 1; d--) {
      const stat = loc.ringStats.find(r => r.distance === d)
      medianVals.push(stat ? stat.median : 0)
      q25Vals.push(stat ? stat.q25 : 0)
      q75Vals.push(stat ? stat.q75 : 0)
    }
    medianVals.push(loc.centerValue)
    q25Vals.push(loc.centerValue)
    q75Vals.push(loc.centerValue)
    for (let d = 1; d <= maxDist; d++) {
      const stat = loc.ringStats.find(r => r.distance === d)
      medianVals.push(stat ? stat.median : 0)
      q25Vals.push(stat ? stat.q25 : 0)
      q75Vals.push(stat ? stat.q75 : 0)
    }

    datasets.push(
      { name: 'Median', values: medianVals },
      { name: '25th percentile', values: q25Vals },
      { name: '75th percentile', values: q75Vals },
    )
  } else {
    // Multiple cities: only median, one line per city
    for (const loc of chartLocations) {
      const vals: number[] = []
      for (let d = maxDist; d >= 1; d--) {
        const stat = loc.ringStats.find(r => r.distance === d)
        vals.push(stat ? stat.median : 0)
      }
      vals.push(loc.centerValue)
      for (let d = 1; d <= maxDist; d++) {
        const stat = loc.ringStats.find(r => r.distance === d)
        vals.push(stat ? stat.median : 0)
      }
      datasets.push({ name: loc.city, values: vals })
    }
  }

  const chartEl = document.getElementById('ring_chart')!
  // Destroy old chart by clearing the container
  chartEl.replaceChildren()
  new Chart(chartEl, {
    data: {
      labels: mirroredLabels,
      datasets,
    },
    type: 'line',
    height: 300,
    colors: chartLocations.length === 1
      ? ['#ff69b4', '#ffa500', '#41c6ff']
      : chartLocations.map(l => l.color),
    axisOptions: {
      xIsSeries: true,
      xAxisMode: 'tick',
      yAxisMode: 'span',
    },
    lineOptions: {
      hideLine: false,
      regionFill: false,
      dotSize: 4,
    },
  })
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
