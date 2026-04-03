import { TileLayer, TileLayerProps, _Tile2DHeader as Tile2DHeader } from '@deck.gl/geo-layers'
import { H3HexagonLayer } from '@deck.gl/geo-layers'
import { load } from '@loaders.gl/core'
import { ArrowLoader } from '@loaders.gl/arrow'
import type { ColumnarTable } from '@loaders.gl/schema'
import H3Tileset2D, { type H3TileIndex } from './vendor/h3-tileset-2d'
import * as h3 from 'h3-js'

export type ArrowColumnarData = ColumnarTable & {
  data: {
    index: string[]
    value: number[]
    [key: string]: ArrayLike<unknown>
  }
}

// Shared tile cache — survives layer replacement
export const tileCache = new Map<string, ArrowColumnarData>()

export interface ArrowH3TileLayerExternalProps {
  getFillColor?: (value: number) => [number, number, number, number]
  colorDomain?: [number, number]
  onDataChange?: () => void
}

export interface ArrowH3TileLayerProps extends Omit<TileLayerProps<ArrowColumnarData>, 'data'>, ArrowH3TileLayerExternalProps {
  data: (tileInfo: { h3Index: string; resolution: number }) => Response | Promise<Response>
}

export class ArrowH3TileLayer extends TileLayer<ArrowColumnarData> {
  static defaultProps = {
    TilesetClass: H3Tileset2D,
  }

  static layerName = 'ArrowH3TileLayer'

  // Collect all loaded values
  getAllValues(): number[] {
    const values: number[] = []
    for (const tileData of tileCache.values()) {
      values.push(...tileData.data.value)
    }
    return values
  }

  // Sample values for quantile computation from currently VISIBLE tiles at the dominant resolution
  getSampleValues(maxSamples: number = 100_000): number[] {
    const { values } = this.getSampleValuesAndWeights(maxSamples)
    return values
  }

  // Sample values and optional weights for weighted quantile computation
  getSampleValuesAndWeights(maxSamples: number = 100_000): { values: number[]; weights?: number[] } {
    const tileset = this.state.tileset
    if (!tileset) return { values: [] }

    // Only sample from tiles that are currently visible in the viewport
    const visibleTiles = tileset.tiles.filter((t: any) => t.isVisible && t.content)
    if (visibleTiles.length === 0) return { values: [] }

    // Find the dominant resolution among visible tiles
    const resCounts = new Map<number, number>()
    for (const tile of visibleTiles) {
      const res = h3.getResolution(tile.content.data.index[0])
      resCounts.set(res, (resCounts.get(res) ?? 0) + tile.content.data.value.length)
    }
    let dominantRes = 0
    let maxCount = 0
    for (const [res, count] of resCounts) {
      if (count > maxCount) {
        maxCount = count
        dominantRes = res
      }
    }

    // Filter to only the dominant resolution
    const filteredTiles = visibleTiles.filter((t: any) => {
      const res = h3.getResolution(t.content.data.index[0])
      return res === dominantRes
    })

    let total = 0
    for (const tile of filteredTiles) {
      total += tile.content.data.value.length
    }

    // Check if weight column exists
    const hasWeights = filteredTiles.length > 0 && filteredTiles[0].content.data.weight !== undefined

    if (total <= maxSamples) {
      const values: number[] = []
      const weights: number[] = []
      for (const tile of filteredTiles) {
        values.push(...tile.content.data.value)
        if (hasWeights) weights.push(...tile.content.data.weight)
      }
      return hasWeights ? { values, weights } : { values }
    }
    // Reservoir sampling
    const values: number[] = new Array(maxSamples)
    const weights: number[] = hasWeights ? new Array(maxSamples) : []
    let n = 0
    for (const tile of filteredTiles) {
      const tileValues = tile.content.data.value
      const tileWeights = hasWeights ? tile.content.data.weight : null
      for (let i = 0; i < tileValues.length; i++) {
        n++
        if (n <= maxSamples) {
          values[n - 1] = tileValues[i]
          if (hasWeights && tileWeights) weights[n - 1] = tileWeights[i]
        } else {
          const j = Math.floor(Math.random() * n)
          if (j < maxSamples) {
            values[j] = tileValues[i]
            if (hasWeights && tileWeights) weights[j] = tileWeights[i]
          }
        }
      }
    }
    return hasWeights ? { values, weights } : { values }
  }

  // Find all rows matching cells in a gridDisk around an h3 index
  getCellsInRadius(h3Index: string, radius: number): { index: string[]; value: number[] }[] {
    const disk = new Set(h3.gridDisk(h3Index, radius))
    const results: { index: string[]; value: number[] }[] = []

    for (const tileData of tileCache.values()) {
      const indices = tileData.data.index
      const values = tileData.data.value
      const matchedIndices: string[] = []
      const matchedValues: number[] = []

      for (let i = 0; i < indices.length; i++) {
        // Convert BigInt to hex string for comparison
        const raw = indices[i] as unknown
        const idxStr = typeof raw === 'bigint' ? raw.toString(16) : String(raw)
        if (disk.has(idxStr)) {
          matchedIndices.push(idxStr)
          matchedValues.push(values[i])
        }
      }

      if (matchedIndices.length > 0) {
        results.push({ index: matchedIndices, value: matchedValues })
      }
    }

    return results
  }

  // @ts-expect-error TileLoadProps uses TileIndex but we use H3TileIndex
  async getTileData(tile: { index: H3TileIndex }): Promise<ArrowColumnarData> {
    const h3Index = tile.index.i
    const resolution = h3.getResolution(tile.index.i)
    const response = await (this.props as unknown as ArrowH3TileLayerProps).data({ h3Index, resolution })

    const data = load(response, ArrowLoader, {
      arrow: {
        shape: 'columnar-table',
      },
    })
    return data as unknown as Promise<ArrowColumnarData>
  }

  renderSubLayers(props: any) {
    const { data, tile } = props
    const extProps = this.props as unknown as ArrowH3TileLayerExternalProps
    const getFillColor = extProps.getFillColor
    const colorDomain = extProps.colorDomain

    if (!data || data.data.index.length === 0) return null

    const h3Indices = data.data.index
    const values = data.data.value

    return new H3HexagonLayer({
      ...props,
      id: `${props.id}-${tile.index.i}`,
      data: { length: values.length },

      getHexagon: (_d: unknown, { index }: { index: number }) => h3Indices.at(index)!.toString(16),

      getFillColor: getFillColor
        ? (_d: unknown, { index }: { index: number }) => getFillColor(values.at(index)!)
        : (_d: unknown, { index }: { index: number }) => [128, 128, 128, 255] as [number, number, number, number],

      updateTriggers: {
        getHexagon: [h3Indices],
        getFillColor: [values, getFillColor, colorDomain],
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
