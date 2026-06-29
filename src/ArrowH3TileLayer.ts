import { TileLayer, TileLayerProps, _Tile2DHeader as Tile2DHeader } from '@deck.gl/geo-layers'
import { H3HexagonLayer } from '@deck.gl/geo-layers'
import { load } from '@loaders.gl/core'
import { ArrowLoader } from '@loaders.gl/arrow'
import { ParquetWasmLoader } from '@loaders.gl/parquet'
import H3Tileset2D, { type H3TileIndex } from './vendor/h3-tileset-2d'
import * as h3 from 'h3-js'
import { Sampler } from './random'
const PARQUET_WASM_URL = "./parquet_wasm_bg.wasm"

export type ArrowColumnarData = {
  shape: 'columnar-table' | 'arrow-table'
  data: any
  schema?: any
}

export function getNumRows(table: ArrowColumnarData): number {
  if (!table) return 0
  if (table.shape === 'columnar-table') {
    const first = Object.values(table.data)[0] as ArrayLike<any>
    return first ? first.length : 0
  }
  const tableData = table.shape === 'arrow-table' ? table.data : table
  return tableData?.numRows ?? 0
}

export function getCol(table: ArrowColumnarData, name: string): any {
  if (!table) return null
  if (table.shape === 'columnar-table') {
    return table.data?.[name]
  }
  const tableData = table.shape === 'arrow-table' ? table.data : table
  return tableData?.getChild?.(name)
}

function colAt(column: any, index: number): any {
  const value = column?.[index]
  return value !== undefined ? value : column?.at?.(index)
}

type Rgba = [number, number, number, number] | number[]
type FillColorFn = (value: number, target?: number[]) => Rgba

const fillColorCache = new WeakMap<ArrowColumnarData, { colorVersion: number; colors: Uint8Array }>()
const subLayerDataCache = new WeakMap<ArrowColumnarData, any>()

function getCachedFillColors(
  tileData: ArrowColumnarData,
  values: any,
  numRows: number,
  getFillColor: FillColorFn,
  colorVersion: number,
) {
  const cached = fillColorCache.get(tileData)
  if (cached?.colorVersion === colorVersion) return cached.colors

  const colors = new Uint8Array(numRows * 4)
  const target = [0, 0, 0, 255]
  for (let i = 0; i < numRows; i++) {
    const colour = getFillColor(Number(colAt(values, i)), target)
    const offset = i * 4
    colors[offset] = colour[0]
    colors[offset + 1] = colour[1]
    colors[offset + 2] = colour[2]
    colors[offset + 3] = colour[3] ?? 255
  }
  fillColorCache.set(tileData, { colorVersion, colors })
  return colors
}

function getSubLayerData(tileData: ArrowColumnarData, numRows: number) {
  let cached = subLayerDataCache.get(tileData)
  if (!cached || cached.length !== numRows) {
    cached = { length: numRows }
    subLayerDataCache.set(tileData, cached)
  }
  return cached
}

// Shared tile cache — survives layer replacement
export const tileCache = new Map<string, ArrowColumnarData>()

export interface ArrowH3TileLayerExternalProps {
  getFillColor?: FillColorFn
  colorVersion?: number
  onDataChange?: () => void
  loader?: 'arrow' | 'parquet'
  resBias?: number
}

export interface ArrowH3TileLayerProps extends Omit<TileLayerProps<ArrowColumnarData>, 'data'>, ArrowH3TileLayerExternalProps {
  data: (tileInfo: { h3Index: string; resolution: number }) => Response | Promise<Response>
}

export class ArrowH3TileLayer extends TileLayer<ArrowColumnarData> {
  static defaultProps = {
    ...TileLayer.defaultProps,
    TilesetClass: H3Tileset2D,
    loader: 'arrow',
    resBias: 0
  }

  static layerName = 'ArrowH3TileLayer'

  _getTilesetOptions() {
    const { resBias } = this.props as unknown as ArrowH3TileLayerProps
    return {
      ...super._getTilesetOptions(),
      resBias
    }
  }

  getSampler(): Sampler | null {
    const tileset = this?.state?.tileset
    if (!tileset) return null
    const visibleTiles = tileset.tiles.filter((t: any) => t.isVisible && t.content);
    if (visibleTiles.length === 0) return null;
    const resCounts = new Map<number, number>()
    for (const tile of visibleTiles) {
      const tileData = tile.content
      const indices = getCol(tileData, 'index')
      const values = getCol(tileData, 'value')
      if (indices && values && getNumRows(tileData) > 0) {
        const raw = colAt(indices, 0)
        const idxStr = typeof raw === 'bigint' ? raw.toString(16) : String(raw)
        const res = h3.getResolution(idxStr)
        resCounts.set(res, (resCounts.get(res) ?? 0) + getNumRows(tileData))
      }
    }
    let dominantRes = 0
    let maxCount = 0
    for (const [res, count] of resCounts) {
      if (count > maxCount) {
        maxCount = count
        dominantRes = res
      }
    }
    
    const filteredTiles = visibleTiles.filter((t: any) => {
      const indices = getCol(t.content, 'index')
      const raw = indices ? colAt(indices, 0) : undefined
      if (!raw) return false
      const idxStr = typeof raw === 'bigint' ? raw.toString(16) : String(raw)
      const res = h3.getResolution(idxStr)
      return res === dominantRes
    })

    let totalRows = 0;
    const tileOffsets: number[] = [];
    for (const tile of filteredTiles) {
      tileOffsets.push(totalRows);
      totalRows += getNumRows(tile.content);
    }

    return {
      totalRows,
      get: (idx: number, field: string) => {
        const tileIdx = tileOffsets.findIndex((o, i) => 
          (tileOffsets[i+1] ?? totalRows) > idx
        )
        
        const tile = filteredTiles[tileIdx];
        const localIdx = idx - tileOffsets[tileIdx];
        return Number(colAt(getCol(tile.content, field), localIdx));
      },
    };
  }

  // Find all rows matching cells in a gridDisk around an h3 index
  getCellsInRadius(h3Index: string, radius: number): { index: string[]; value: number[], weight?: number[] }[] {
    const disk = new Set(h3.gridDisk(h3Index, radius))
    const results: { index: string[]; value: number[]; weight?: number[] }[] = []

    for (const tileData of tileCache.values()) {
      const indices = getCol(tileData, 'index')
      const values = getCol(tileData, 'value')
      const weights = getCol(tileData, 'weight')
      const numRows = getNumRows(tileData)
      const matchedIndices: string[] = []
      const matchedValues: number[] = []
      const matchedWeights: number[] = []

      for (let i = 0; i < numRows; i++) {
        // Convert BigInt to hex string for comparison
        const raw = colAt(indices, i) as unknown
        const idxStr = typeof raw === 'bigint' ? raw.toString(16) : String(raw)
        if (disk.has(idxStr)) {
          matchedIndices.push(idxStr)
          const val = colAt(values, i)
          if (val !== undefined) matchedValues.push(Number(val))
          const w = weights ? colAt(weights, i) : undefined
          matchedWeights.push(w !== undefined ? Number(w) : 1)
        }
      }

      if (matchedIndices.length > 0) {
        results.push({ index: matchedIndices, value: matchedValues, weight: matchedWeights })
      }
    }

    return results
  }

  // @ts-expect-error TileLoadProps uses TileIndex but we use H3TileIndex
  async getTileData(tile: { index: H3TileIndex }): Promise<ArrowColumnarData> {
    const h3Index = tile.index.i
    const resolution = h3.getResolution(tile.index.i)
    const { data: dataGen, loader } = this.props as unknown as ArrowH3TileLayerProps
    const response = await dataGen({ h3Index, resolution })

    const data = await load(response, loader === 'parquet' ? ParquetWasmLoader : ArrowLoader, {
      parquet: { wasmUrl: PARQUET_WASM_URL },
      arrow: { shape: 'columnar-table' },
    })
    return data as ArrowColumnarData
  }

  renderSubLayers(props: any) {
    const { data, tile } = props
    const extProps = this.props as unknown as ArrowH3TileLayerExternalProps
    const getFillColor = extProps.getFillColor
    const { colorVersion = 0 } = extProps

    const h3Indices = getCol(data, 'index')
    const values = getCol(data, 'value')
    const numRows = getNumRows(data)

    if (!h3Indices || !values || numRows === 0) return null

    const fillColors = getFillColor
      ? getCachedFillColors(data, values, numRows, getFillColor, colorVersion)
      : null
    const dataWrap = getSubLayerData(data, numRows)
    if (fillColors) {
      dataWrap.attributes = {
        getFillColor: { value: fillColors, size: 4, type: 'unorm8' },
      }
      dataWrap.startIndices = null
    } else {
      delete dataWrap.attributes
      delete dataWrap.startIndices
    }

    return new H3HexagonLayer({
      ...props,
      id: `${props.id}-${tile.index.i}`,
      data: dataWrap,

      getHexagon: (_d: unknown, { index }: { index: number }) => {
        const raw = colAt(h3Indices, index)!
        return typeof raw === 'bigint' ? raw.toString(16) : raw.toString()
      },

      getFillColor: getFillColor
        ? (_d: unknown, { index, target }: { index: number; target?: number[] }) => getFillColor(Number(colAt(values, index)!), target)
        : (_d: unknown, { index }: { index: number }) => [128, 128, 128, 255] as [number, number, number, number],

      updateTriggers: {
        getHexagon: [h3Indices],
        getFillColor: [colorVersion, fillColors],
      },
      opacity: 1,
      extruded: false,
      stroked: false,
    })
  }

  _onTileLoad(tile: Tile2DHeader<ArrowColumnarData>) {
    if (tile.content) {
      const tileId = this.state.tileset?.getTileId(tile.index) ?? tile.id
      tileCache.set(tileId, tile.content)
      const extProps = this.props as unknown as ArrowH3TileLayerExternalProps
      extProps.onDataChange?.()
    }
    super._onTileLoad(tile)
  }

  _onTileUnload(tile: Tile2DHeader<ArrowColumnarData>) {
    const tileId = this.state.tileset?.getTileId(tile.index) ?? tile.id
    tileCache.delete(tileId)
    const extProps = this.props as unknown as ArrowH3TileLayerExternalProps
    extProps.onDataChange?.()
    super._onTileUnload(tile)
  }
}
