import { MapboxOverlay } from '@deck.gl/mapbox'
import { H3HexagonLayer } from '@deck.gl/geo-layers'
import maplibregl from 'maplibre-gl'
import * as d3 from 'd3'
import * as d3s from 'd3-scale-chromatic'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as observablehq from './vendor/observablehq'
import * as aq from 'arquero'
import * as h3 from 'h3-js'
import { ArrowH3TileLayer, getCol } from './ArrowH3TileLayer'
import { D3LineChart } from './d3-line-chart'
import { findClosestCity } from './tiny-cities'
import tinyCities from './tiny-cities.json'
(window as any).findClosestCity = findClosestCity

const username = 'public_web';
const password = 'a2hkayBzZGlsO2RqIHNsayBsYWpzZCBmbGogc2Rsa2og';
const ch_endpoint = "https://compute.olie.science/ch";

const IS_MOBILE = navigator.userAgent.includes("Mobi")

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
  style: 'https://compute.olie.science/fahrtle/toner_ofm_moderatlist.json',
  center: [start_pos.x, start_pos.y],
  zoom: start_pos.z,
  maxZoom: 18,
  minZoom: 1,
  bearing: 0,
  pitch: 0,
  boxZoom: false,
})

const colourSchemes = Object.keys(d3s).filter(k => k.startsWith('interpolate') && typeof (d3s as any)[k] === 'function')
const _csParam = new URLSearchParams(window.location.search).get('cs')
let currentColourScheme: string = colourSchemes.includes(_csParam ?? '') ? _csParam! : 'interpolateSpectral'
let colourInverted = new URLSearchParams(window.location.search).get('ci') == '1'
const colourRamp = d3.scaleSequential<string>((d3s as any)[currentColourScheme]).domain(colourInverted ? [1, 0] : [0, 1])

// Populate colour scheme dropdown (after Shoelace loads)
customElements.whenDefined('sl-select').then(() => {
  const colourSchemeSelect = document.getElementById('colour_scheme') as any
  if (colourSchemeSelect) {
    for (const scheme of colourSchemes.sort()) {
      const option = document.createElement('sl-option') as any
      option.value = scheme
      option.textContent = scheme.replace('interpolate', '')
      colourSchemeSelect.appendChild(option)
    }
  }
})
let getQuantile: ((v: number) => number) | undefined
let getValueFromQuantile: ((q: number) => number) | undefined

// prevent dumb reactivity on function factories
function memoise<TArg, TResult>(fn: (arg: TArg) => TResult) {
  const cache = new Map<TArg, TResult>()
  return (arg: TArg): TResult => {
    if (!cache.has(arg)) {
      cache.set(arg, fn(arg))
    }
    return cache.get(arg)!
  }
}

const _getColour = (getQuantile: (v: number) => number) => (v: number): [number, number, number, number] => {
  const q = getQuantile ? getQuantile(v) : 0
  const c = d3.color(colourRamp(q))!
  const rgb = c.formatRgb().match(/[\d.]+/g)!.map(Number)
  return [rgb[0], rgb[1], rgb[2], 255]
}
const getColour = memoise(_getColour)

function human(number: number): string {
  return parseFloat(number.toPrecision(2)).toLocaleString()
}

const LOADER = 'arrow'
function chQuery(query: string): Promise<Response> {
  // return fetch(`${ch_endpoint}/?query=${encodeURIComponent(query + " format parquet")}`, {
  return fetch(`${ch_endpoint}/?query=${encodeURIComponent(query + " format arrow settings output_format_arrow_compression_method = 'none'")}`, {
    headers: new Headers({
      Authorization: `Basic ${btoa(username + ':' + password)}`,
    }),
  })
}

const urlParams = new URLSearchParams(window.location.search)
let RESOLUTION_MODIFIER = urlParams.has('res') ? Number(urlParams.get('res')) : 0
let accumulateCities = urlParams.has('acc') && urlParams.get('acc') !== '0' && urlParams.get('acc') !== 'false'
let colourByWeights = urlParams.has('w') && urlParams.get('w') !== '0' && urlParams.get('w') !== 'false'
const _chquerygen = (RESOLUTION_MODIFIER: number) => (({ h3Index, resolution }: { h3Index: string; resolution: number }) => {
  const query = `
      select h3ToParent(h3, least(${resolution + 2 + (IS_MOBILE ? 0 : 1) + RESOLUTION_MODIFIER}, h3GetResolution(h3))) index,
      sum(population)/(h3CellAreaM2(index)/(1000*1000)) _value,
      if(_value = 0, 0, 
          round(_value * pow(10, 3 - 1 - floor(log10(abs(_value))))) 
          / pow(10, 3 - 1 - floor(log10(abs(_value))))
      ) AS value,
      sum(population) weight
      from public_kontur_population_20231101
      where h3ToParent(h3, ${resolution}) = reinterpretAsUInt64(reverse(unhex('${h3Index}')))
      group by index
  `
  return chQuery(query)
})
const chquerygen = memoise(_chquerygen)

// ---- Legend ----
let legendElement: SVGSVGElement | null = null
const attributionEl = document.getElementById('attribution')!

// Throttled legend update: fires immediately, then waits 500ms before next call
let legendThrottleTimer: ReturnType<typeof setTimeout> | null = null

let wantsUpdate = false
const _throttledUpdateLegend = (colourByWeights: boolean) => () => {
  if (legendThrottleTimer) {
    wantsUpdate = true
    return
  }
  updateLegend(colourByWeights)
  legendThrottleTimer = setTimeout(() => {
    legendThrottleTimer = null
    wantsUpdate && updateLegend(colourByWeights)
    wantsUpdate = false
  }, 1000)
}
const throttledUpdateLegend = memoise(_throttledUpdateLegend)

function buildEcdf(values: number[], weights: number[]): { getQuantile: (v: number) => number; getValueFromQuantile: (q: number) => number } {
  const sampleSize = Math.min(256, values.length)
  const indices = Array.from({ length: sampleSize }, () => Math.floor(Math.random() * values.length))
  const pairs = indices.map(i => [values[i], weights ? weights[i] : 1] as [number, number])
  pairs.sort((a, b) => a[0] - b[0])
  const sortedValues = pairs.map(([v]) => v)
  const sortedWeights = pairs.map(([, w]) => w)
  let cumW = 0
  const totalW = sortedWeights.reduce((s, w) => s + w, 0)
  const quantiles = sortedWeights.map(w => { cumW += w; return cumW / totalW })

  const getQuantile = (target: number): number => {
    const idx = sortedValues.findIndex(v => v > target)
    return idx === -1 ? 1 : quantiles[idx]
  }

  const getValueFromQuantile = (target: number): number => {
    const trimTarget = Math.min(Math.max(0.01, target), 0.99)
    const idx = quantiles.findIndex(q => q > trimTarget)
    return idx === -1 ? sortedValues[sortedValues.length - 1] : sortedValues[idx]
  }

  return { getQuantile, getValueFromQuantile }
}

function updateLegend(colourByWeights: boolean) {
  const { values, weights } = h3Layer.getSampleValuesAndWeights(1_000)
  if (values.length === 0) return

  const effectiveWeights = colourByWeights && weights && weights.length === values.length ? weights : new Array(values.length).fill(1)

  // Build ECDF
  const ecdf = buildEcdf(values, effectiveWeights)
  getQuantile = ecdf.getQuantile
  getValueFromQuantile = ecdf.getValueFromQuantile

  // Re-render legend with quantile-based ticks
  const tickFormat = (v: number) => {
    const rawValue = ecdf.getValueFromQuantile(v)
    const rounded = parseFloat(rawValue.toPrecision(2))
    return rounded.toLocaleString()
  }

  if (legendElement) {
    legendElement.remove()
  }
  legendElement = observablehq.legend({ color: colourRamp, title: 'Population per km²', tickFormat })
  attributionEl.insertBefore(legendElement, attributionEl.firstChild)

  // Force re-render of hex layers
  h3Layer = new ArrowH3TileLayer({
    id: 'H3TileLayer',
    // @ts-expect-error custom data function and layer type
    data: chquerygen(RESOLUTION_MODIFIER),
    pickable: true,
    getFillColor: getColour(getQuantile),
    colorDomain: [0, 1],
    onDataChange: throttledUpdateLegend(colourByWeights),
    loader: LOADER,
  })
    mapOverlay.setProps({ layers: [h3Layer, getHighlightData(cumulativeHighlightDt)] })

}

// ---- Click / median ----
let lastDensity: number | undefined
let lastLandDensity: number | undefined
let lastPop: number | undefined
let lastInfo: any

// Chart state: array of { city, ringStats, centerValue }
let chartLocations: {
  city: string
  lat: number
  lon: number
  ringStats: { distance: number; median: number; q25: number; q75: number; count: number }[]
  centerValue: number
  color: string
  ecdfData: { quantile: number; value: number }[]
  cumPopData: { distance: number; cumPop: number }[]
}[] = []

let cumulativeHighlightDt: any = null

const COLORS = ['#ff69b4', '#ffa500', '#41c6ff', '#7cfc00', '#ff4500', '#9370db', '#00ced1', '#ffd700']

let h3Layer = new ArrowH3TileLayer({
  id: 'H3TileLayer',
  // @ts-expect-error custom data function and layer type
  data: chquerygen(RESOLUTION_MODIFIER),
  pickable: true,
  getFillColor: getColour(getQuantile!),
  colorDomain: [0, 1],
  onDataChange: throttledUpdateLegend(colourByWeights),
  loader: LOADER,
})

// Capture shift state at mousedown time (before keyup can interfere)
let clickShiftState = false
document.addEventListener('mousedown', (e) => { clickShiftState = e.shiftKey })

const mapOverlay = new MapboxOverlay({
  interleaved: false,
  onClick: (info: any) => {
    makeHighlight(info, undefined, clickShiftState || accumulateCities)
  },
  getTooltip: (info: any) => {
    if (info.index === undefined || !info.sourceTile?.content) return null

    const idx = info.index
    const data = info.sourceTile.content
    const indices = getCol(data, 'index')
    const values = getCol(data, 'value')
    if (!indices || !values) return null

    const raw = indices.at(idx)
    const h3Index = typeof raw === 'bigint' ? raw.toString(16) : String(raw)
    const value = values.at(idx)

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

const getHighlightData = (df: any) => {
  if (df == null) return undefined
  return new H3HexagonLayer({
    id: 'selectedHex',
    ish3: true,
    data: df.objects(),
    extruded: false,
    stroked: false,
    getHexagon: (d: any) => d.index,
    getFillColor: () => [0, 255, 0, 100] as [number, number, number, number],
    pickable: true,
  })
}

function makeHighlight(info: any | undefined, force_radius: number | undefined, append = false) {
  lastInfo = info ?? lastInfo
  if (info?.layer == null) {
    return
  }
  if (info.layer.id === 'selectedHex') {
    chartLocations = []
    cumulativeHighlightDt = null
    mapOverlay.setProps({ layers: [h3Layer, getHighlightData(cumulativeHighlightDt)] })
    return
  }
  // Accept clicks on any layer (not just ones with ish3 prop)
  if (info.layer.id === 'H3TileLayer') {
    const radius = force_radius ?? Number((document.getElementById('desired_radius') as HTMLInputElement).value)

    // Get the clicked H3 index from the tile content
    const data = info.sourceTile?.content
    const indices = getCol(data, 'index')
    const clickedIndexRaw = indices?.at(info.index)
    if (clickedIndexRaw === undefined) {
      console.warn('[makeHighlight] Could not find clicked H3 index')
      return
    }
    // Convert BigInt to hex string for h3-js
    const clickedIndex = typeof clickedIndexRaw === 'bigint'
      ? clickedIndexRaw.toString(16)
      : String(clickedIndexRaw)

    // Get all matching cells from loaded tiles
    const matchedTiles = h3Layer.getCellsInRadius(clickedIndex, radius)
    let totalMatched = 0
    for (const g of matchedTiles) {
      totalMatched += g.index.length
    }

    // Build an arquero table from matched data
    const allIndices: string[] = []
    const allValues: number[] = []
    const allWeights: number[] = []
    for (const g of matchedTiles) {
      allIndices.push(...g.index)
      allValues.push(...g.value)
      const weights = g?.weight ?? new Array(g.index.length).fill(1)
      allWeights.push(...weights)
    }

    let dt = aq.table({ index: allIndices, value: allValues, weight: allWeights })

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
      ; (window as any).dt = dt

    lastDensity = (dt.get('value', 0) as number)
    const last75Density = (dt.orderby('q75_dist').get('value', 0) as number)
    const last25Density = (dt.orderby('q25_dist').get('value', 0) as number)
    lastLandDensity = (dt.rollup({ median: (d: any) => aq.op.median(d.value) }).get('median') as number)

    const res = h3.getResolution(dt.get('index', 0) as string)
    const areaKm2 = h3.getHexagonAreaAvg(res, 'km2')
    const diamKm = h3.getHexagonEdgeLengthAvg(res, 'km') * 2

    // Log density quantiles per hollow ring
    const ringStats: { distance: number; median: number; q25: number; q75: number; count: number }[] = []
    for (let d = 0; d <= radius; d++) {
      const ring = h3.gridRing(clickedIndex, d)
      if (ring.length === 0) continue

      // Find matching cells in this ring
      const ringSet = new Set(ring)
      const ringValues: number[] = []
      const ringWeights: number[] = []
      for (const g of matchedTiles) {
        for (let i = 0; i < g.index.length; i++) {
          if (ringSet.has(g.index[i])) {
            ringValues.push(g.value[i])
            ringWeights.push(g.weight ? g.weight[i] : 1)
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
        .derive({ cumsum: aq.rolling((d: any) => aq.op.sum(d.value)) }) // todo: shouldn't this be on weight? but then need to find value for each weight
        .derive({ quantile: (d: any) => d.cumsum / aq.op.sum(d.value) })
        .derive({
          median_dist: (d: any) => aq.op.abs(d.quantile - 0.5),
          q75_dist: (d: any) => aq.op.abs(d.quantile - 0.75),
          q25_dist: (d: any) => aq.op.abs(d.quantile - 0.25),
        })

      const median = (ringTable.orderby('median_dist').get('value', 0) as number)
      const q25 = (ringTable.orderby('q25_dist').get('value', 0) as number)
      const q75 = (ringTable.orderby('q75_dist').get('value', 0) as number)

      ringStats.push({ distance: d * diamKm, median, q25, q75, count: ringValues.length })
    }

    // Build ECDF data: sorted values with cumulative weight
    const sortedDt = aq.table({ index: allIndices, value: allValues, weight: allWeights })
      .groupby('index')
      .rollup({ value: (d: any) => aq.op.max(d.value), weight: (d: any) => aq.op.max(d.weight) })
      .orderby('value')

    let totalWeight = 0
    for (let i = 0; i < sortedDt.numRows(); i++) {
      totalWeight += sortedDt.get('weight', i) as number
    }

    const ecdfData: { quantile: number; value: number }[] = []
    let cumsum = 0
    for (let i = 0; i < sortedDt.numRows(); i++) {
      const v = sortedDt.get('value', i) as number
      const w = sortedDt.get('weight', i) as number
      cumsum += w
      ecdfData.push({
        quantile: cumsum / totalWeight,
        value: v,
      })
    }

    // Build cumulative population by distance
    const cumPopData: { distance: number; cumPop: number }[] = []
    let runningPop = 0
    for (let d = 0; d <= radius; d++) {
      const ring = h3.gridRing(clickedIndex, d)
      if (ring.length === 0) continue

      const ringSet = new Set(ring)
      let ringPop = 0
      for (const g of matchedTiles) {
        for (let i = 0; i < g.index.length; i++) {
          if (ringSet.has(g.index[i])) {
            ringPop += g.value[i]
          }
        }
      }
      runningPop += ringPop * areaKm2
      cumPopData.push({ distance: d * diamKm, cumPop: runningPop })
    }
    const centerLat = h3.cellToLatLng(clickedIndex)[0]
    const centerLon = h3.cellToLatLng(clickedIndex)[1]
    const cityLabel = findClosestCity(centerLat, centerLon)
    const centerValue = (dt.get('value', 0) as number)
    console.log(cityLabel)
    console.table(ringStats)
    console.table(ecdfData)
    console.table(cumPopData)
    lastPop = runningPop

    // Build or append chart data
    if (append) {
      chartLocations.push({ city: cityLabel, lat: centerLat, lon: centerLon, ringStats, centerValue, color: COLORS[chartLocations.length % COLORS.length], ecdfData, cumPopData })
      cumulativeHighlightDt = cumulativeHighlightDt ? cumulativeHighlightDt.concat(dt) : dt
    } else {
      chartLocations = [{ city: cityLabel, lat: centerLat, lon: centerLon, ringStats, centerValue, color: COLORS[0], ecdfData, cumPopData }]
      cumulativeHighlightDt = dt
    }

    renderChart()

    document.getElementById('results_text')!.innerHTML = `
            <p><b>${cityLabel}</b>:</p>
            <p>Approx radius: ${human(h3.getHexagonEdgeLengthAvg(res, 'km') * 2 * radius + 1)} km </p>
            <p>Median population density weighted by population: <b>${human(lastDensity)}</b> / km², 75th percentile: <b>${human(last75Density)}</b> / km², 25th percentile: <b>${human(last25Density)}</b> / km² </p>
            <p>Median population density weighted by populated land area: <b>${human(lastLandDensity)}</b> / km²                   </p>
            <p>Total population: <b>${human(lastPop)}</b>                                                                          </p>
            `
      ; (document.getElementById('settings') as any).show()
    mapOverlay.setProps({ layers: [h3Layer, getHighlightData(cumulativeHighlightDt)] })
  }
}

function renderChart() {
  if (chartLocations.length === 0) return

  // Build symmetric labels from the first location
  const first = chartLocations[0]
  const maxDist = first.ringStats.length

  const datasets: any[] = []

  if (chartLocations.length === 1) {
    // Single city: show median, 25th, 75th
    const loc = chartLocations[0]
    const medianVals: number[] = []
    const q25Vals: number[] = []
    const q75Vals: number[] = []
    const xVals: number[] = []

    for (let d = maxDist - 1; d >= 1; d--) {
      const stat = loc.ringStats[d]
      xVals.push(stat ? -stat.distance : 0)
      medianVals.push(stat ? stat.median : 0)
      q25Vals.push(stat ? stat.q25 : 0)
      q75Vals.push(stat ? stat.q75 : 0)
    }
    for (let d = 0; d < maxDist; d++) {
      const stat = loc.ringStats[d]
      xVals.push(stat ? stat.distance : 0)
      medianVals.push(stat ? stat.median : 0)
      q25Vals.push(stat ? stat.q25 : 0)
      q75Vals.push(stat ? stat.q75 : 0)
    }

    datasets.push(
      { name: 'Median', values: medianVals, xValues: xVals },
      { name: '25th percentile', values: q25Vals, xValues: xVals },
      { name: '75th percentile', values: q75Vals, xValues: xVals },
    )
  } else {
    for (const loc of chartLocations) {
      const vals: number[] = []
      const xVals: number[] = []
      for (let d = maxDist - 1; d >= 1; d--) {
        const stat = loc.ringStats[d]
        xVals.push(stat ? -stat.distance : 0)
        vals.push(stat ? stat.median : 0)
      }
      for (let d = 0; d < maxDist; d++) {
        const stat = loc.ringStats[d]
        xVals.push(stat ? stat.distance : 0)
        vals.push(stat ? stat.median : 0)
      }
      datasets.push({ name: loc.city, values: vals, xValues: xVals })
    }
  }

  const chartEl = document.getElementById('ring_chart')!
  const data = {
    datasets,
  }
  const config = {
    type: 'line',
    height: 300,
    title: "Weighted population density versus km from centre",
    colors: chartLocations.length === 1
      ? ['#ff69b4', '#ffa500', '#41c6ff']
      : chartLocations.map(l => l.color),
    axisOptions: {
      xIsSeries: true,
      xAxisMode: 'tick',
      yAxisMode: 'span',
    },
    lineOptions: {
      hideDots: 1,
    },
    animate: false,
  }
  if (chart == undefined) {
    chart = new D3LineChart(chartEl, {
      data,
      ...config,
    })
  } else {
    chart.update(data, config)
  }

  renderEcdfChart()
  renderCumPopChart()
}

function renderEcdfChart() {
  if (chartLocations.length === 0) return

  const datasets: any[] = []
  const colors: string[] = []

  const percentileStep = 5
  const percentiles: number[] = []
  for (let p = 0; p <= 100; p += percentileStep) {
    percentiles.push(p)
  }

  for (const loc of chartLocations) {
    const sorted = loc.ecdfData.slice().sort((a: any, b: any) => a.quantile - b.quantile)

    const values: number[] = []
    for (const p of percentiles) {
      const target = p / 100
      let lo = 0, hi = sorted.length - 1
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1
        if (sorted[mid].quantile <= target) lo = mid
        else hi = mid
      }
      const q0 = sorted[lo].quantile, v0 = sorted[lo].value
      const q1 = sorted[hi].quantile, v1 = sorted[hi].value
      const t = q1 === q0 ? 0 : (target - q0) / (q1 - q0)
      values.push(v0 + t * (v1 - v0))
    }

    datasets.push({ name: loc.city, values, xValues: percentiles })
    colors.push(loc.color)
  }

  const chartTitle = "Population density versus weighted percentile"

  const chartEl = document.getElementById('ecdf_chart')!
  const chartData = {
    datasets,
  }
  const config = {
    type: 'line',
    height: 300,
    title: chartTitle,
    colors,
    axisOptions: {
      xIsSeries: true,
      xAxisMode: 'tick',
      yAxisMode: 'span',
    },
    lineOptions: {
      hideDots: 1,
    },
    animate: false,
  }
  if (ecdfChart == undefined) {
    ecdfChart = new D3LineChart(chartEl, {
      data: chartData,
      ...config,
    })
  } else {
    ecdfChart.update(chartData, config)
  }
}

function renderCumPopChart() {
  if (chartLocations.length === 0) return

  const datasets: any[] = []
  const colors: string[] = []

  const first = chartLocations[0]

  for (const loc of chartLocations) {
    const values = loc.cumPopData.map((d: any) => d.cumPop)
    const xValues = loc.cumPopData.map((d: any) => d.distance)

    datasets.push({ name: loc.city, values, xValues })
    colors.push(loc.color)
  }

  const chartEl = document.getElementById('cumpop_chart')!
  const chartData = {
    datasets,
  }
  const chartTitle = "Cumulative population versus km from centre"
  const config = {
    type: 'line',
    height: 300,
    title: chartTitle,
    colors,
    axisOptions: {
      xIsSeries: true,
      xAxisMode: 'tick',
      yAxisMode: 'span',
    },
    lineOptions: {
      hideDots: 1,
    },
    animate: false,
  }
  if (cumPopChart == undefined) {
    cumPopChart = new D3LineChart(chartEl, {
      data: chartData,
      ...config,
    })
  } else {
    cumPopChart.update(chartData, config)
  }
}

let chart: D3LineChart | undefined
let ecdfChart: D3LineChart | undefined
let cumPopChart: D3LineChart | undefined

map.addControl(mapOverlay)
map.addControl(new maplibregl.NavigationControl())

// ---- Settings registry ----
interface SettingSpec<T> {
  param: string
  default: T
  parse: (raw: string | null) => T
  serialize: (v: T) => string
  onChange: (v: T, el: HTMLElement) => void
}

const settings: SettingSpec<any>[] = []

function registerSetting<T>(spec: SettingSpec<T>) {
  settings.push(spec)
}

function initSettings() {
  const params = new URLSearchParams(window.location.search)

  for (const spec of settings) {
    const el = document.querySelector(`[data-param="${spec.param}"]`) as HTMLElement | null
    if (!el) continue

    const value = spec.parse(params.get(spec.param))
    applySettingToElement(el, value)

    el.addEventListener('sl-change', (e: Event) => {
      const newValue = readSettingFromElement(el, spec)
      spec.onChange(newValue, el)
      params.set(spec.param, spec.serialize(newValue))
      history.replaceState(null, '', `?${params.toString()}${window.location.hash}`)
    })
  }
}

async function waitForShoelace() {
  const elements = document.querySelectorAll('[data-param]')
  await Promise.all(
    Array.from(elements).map(el =>
      el.tagName.includes('-') && !customElements.get(el.tagName.toLowerCase())
        ? customElements.whenDefined(el.tagName.toLowerCase())
        : Promise.resolve()
    )
  )
}

waitForShoelace().then(() => initSettings())

function applySettingToElement(el: HTMLElement, value: any) {
  if (el.tagName.toLowerCase().includes('checkbox')) {
    ; (el as any).checked = value
  } else if (el.tagName.toLowerCase().includes('range') || el.tagName.toLowerCase().includes('input')) {
    ; (el as any).value = value
  }
}

function readSettingFromElement(el: HTMLElement, spec: SettingSpec<any>): any {
  if (el.tagName.toLowerCase().includes('checkbox')) {
    return (el as any).checked
  }
  return (el as any).value
}

registerSetting<number>({
  param: 'res',
  default: 0,
  parse: (raw) => raw !== null ? Number(raw) : 0,
  serialize: (v) => String(v),
  onChange: (value) => {
    RESOLUTION_MODIFIER = value
    h3Layer = new ArrowH3TileLayer({
      id: 'H3TileLayer',
      // @ts-expect-error custom data function and layer type
      data: chquerygen(RESOLUTION_MODIFIER),
      pickable: true,
      getFillColor: getColour(getQuantile!),
      colorDomain: [0, 1],
      onDataChange: throttledUpdateLegend(colourByWeights),
      loader: LOADER,
    })
    mapOverlay.setProps({ layers: [h3Layer, getHighlightData(cumulativeHighlightDt)] })
  },
})

registerSetting<number>({
  param: 'rad',
  default: 15,
  parse: (raw) => raw !== null ? Number(raw) : 15,
  serialize: (v) => String(v),
  onChange: (value) => {
    if (lastInfo == undefined) return
    makeHighlight(lastInfo, value)
  },
})

registerSetting<boolean>({
  param: 'acc',
  default: false,
  parse: (raw) => raw !== null && raw !== '0' && raw !== 'false',
  serialize: (v) => v ? '1' : '0',
  onChange: (value) => {
    accumulateCities = value
  },
})

registerSetting<boolean>({
  param: 'w',
  default: false,
  parse: (raw) => raw !== null && raw !== '0' && raw !== 'false',
  serialize: (v) => v ? '1' : '0',
  onChange: (value) => {
    colourByWeights = value
    updateLegend(colourByWeights)
    h3Layer = new ArrowH3TileLayer({
      id: 'H3TileLayer',
      // @ts-expect-error custom data function and layer type
      data: chquerygen(RESOLUTION_MODIFIER),
      pickable: true,
      getFillColor: getColour(getQuantile!),
      colorDomain: [0, 1],
      onDataChange: throttledUpdateLegend(colourByWeights),
      loader: LOADER,
    })
    mapOverlay.setProps({ layers: [h3Layer, getHighlightData(cumulativeHighlightDt)] })
  },
})

registerSetting<string>({
  param: 'cs',
  default: 'interpolateSpectral',
  parse: (raw) => {
    if (raw === null) return 'interpolateSpectral'
    return colourSchemes.includes(raw) ? raw : 'interpolateSpectral'
  },
  serialize: (v) => v,
  onChange: (value) => {
    currentColourScheme = value
    colourRamp.interpolator((d3s as any)[value])
    h3Layer = new ArrowH3TileLayer({
      id: 'H3TileLayer',
      // @ts-expect-error custom data function and layer type
      data: chquerygen(RESOLUTION_MODIFIER),
      pickable: true,
      getFillColor: getColour(getQuantile!),
      colorDomain: [0, 1],
      onDataChange: throttledUpdateLegend(colourByWeights),
      loader: LOADER,
    })
    mapOverlay.setProps({ layers: [h3Layer, getHighlightData(cumulativeHighlightDt)] })
    updateLegend(colourByWeights)
  },
})

registerSetting<boolean>({
  param: 'ci',
  default: false,
  parse: (raw) => raw !== null && raw !== '0' && raw !== 'false',
  serialize: (v) => v ? '1' : '0',
  onChange: (value) => {
    colourInverted = value
    colourRamp.domain(value ? [1, 0] : [0, 1])
    h3Layer = new ArrowH3TileLayer({
      id: 'H3TileLayer',
      // @ts-expect-error custom data function and layer type
      data: chquerygen(RESOLUTION_MODIFIER),
      pickable: true,
      getFillColor: getColour(getQuantile!),
      colorDomain: [0, 1],
      onDataChange: throttledUpdateLegend(colourByWeights),
      loader: LOADER,
    })
    mapOverlay.setProps({ layers: [h3Layer, getHighlightData(cumulativeHighlightDt)] })
    // updateLegend(colourByWeights) // todo: fix
  },
})

// ---- Attribution ----
const params = new URLSearchParams(window.location.search)
attributionEl.innerText =
  '© ' +
  [params.get('c'), 'bovine3dom', 'Mapterhorn', 'Versatiles', 'GEBCO\n', 'Natural Earth', 'Kontur', 'GHSL', 'OpenFreeMap\n', 'OpenStreetMap contributors']
    .filter((x) => x !== null)
    .join(' © ')

const citySearchEl = document.getElementById('city_search') as any
const MAX_RESULTS = 10

function searchCities(query: string): Array<{ label: string; lat: number; lon: number }> {
  if (!query) return []
  const q = query.toLowerCase()
  return tinyCities
    .filter(c => c.name.toLowerCase().startsWith(q) || c.country_code.toLowerCase().startsWith(q))
    .slice(0, MAX_RESULTS)
    .map(c => ({
      label: `${c.name}, ${c.country_code}`,
      lat: c.latitude,
      lon: c.longitude,
    }))
}

if (citySearchEl) {
  const dropdown = document.createElement('sl-dropdown') as any
  dropdown.containment = 'viewport'
  dropdown.hoist = true
  dropdown.placement = 'bottom-start'
  dropdown.distance = 4

  citySearchEl.replaceWith(dropdown)
  dropdown.appendChild(citySearchEl)
  citySearchEl.slot = 'trigger'

  const menu = document.createElement('sl-menu') as any
  dropdown.appendChild(menu)

  function showResults(query: string) {
    const results = searchCities(query)
    menu.innerHTML = ''
    if (!results.length) {
      dropdown.hide()
      return
    }
    for (const r of results) {
      const item = document.createElement('sl-menu-item') as any
      item.textContent = r.label
      item.addEventListener('click', () => {
        citySearchEl.value = r.label
        dropdown.hide()
        map.flyTo({ center: [r.lon, r.lat], zoom: 12, duration: 1500 })
      })
      menu.appendChild(item)
    }
    dropdown.show()
  }

  citySearchEl.addEventListener('sl-input', () => {
    showResults(citySearchEl.value)
  })

  citySearchEl.addEventListener('sl-clear', () => {
    dropdown.hide()
  })

  citySearchEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      const results = searchCities(citySearchEl.value)
      if (results.length > 0) {
        const r = results[0]
        citySearchEl.value = r.label
        dropdown.hide()
        map.flyTo({ center: [r.lon, r.lat], zoom: 12, duration: 1500 })
      }
    }
  })
}

// ---- Keyboard navigation ----
const PAN_DELTA = 100
const ZOOM_DELTA = 1
document.addEventListener('keydown', (e) => {
  // ignore inputs
  const el = e.target as HTMLElement
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'sl-input' || tag === 'sl-select' || tag === 'sl-textarea') return
  if (el.closest('sl-input, sl-select, sl-textarea')) return
  if ((e.composedPath() as HTMLElement[]).some(n => {
    const t = (n as HTMLElement).tagName?.toLowerCase()
    return t === 'sl-input' || t === 'sl-select' || t === 'sl-textarea'
  })) return

  const dx = (() => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') return -PAN_DELTA
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') return PAN_DELTA
    return 0
  })()
  const dy = (() => {
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') return -PAN_DELTA
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') return PAN_DELTA
    return 0
  })()
  const zoom = (() => {
    if (e.key === '+' || e.key === '=' || e.key === 'e' || e.key === 'E') return ZOOM_DELTA
    if (e.key === '-' || e.key === '_' || e.key === 'q' || e.key === 'Q') return -ZOOM_DELTA
    return 0
  })()

  if (dx || dy) {
    map.panBy([dx, dy], { animate: true, duration: 200 })
    e.preventDefault()
  }
  if (zoom) {
    if (zoom > 0) map.zoomIn({ animate: true, duration: 200 })
    else map.zoomOut({ animate: true, duration: 200 })
    e.preventDefault()
  }
})

// ---- Hash updates ----
map.on('moveend', () => {
  const pos = map.getCenter()
  const z = map.getZoom()
  history.replaceState(null, '', `#x=${pos.lng.toFixed(4)}&y=${pos.lat.toFixed(4)}&z=${z.toFixed(4)}`)
})

// ---- Favicon ----
const setFavicon = () => {
  const favicon = document.querySelector('link[rel="icon"]') as HTMLLinkElement
  favicon.href = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'cow.svg' : 'cow-light.svg'
}
setFavicon()
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setFavicon)
