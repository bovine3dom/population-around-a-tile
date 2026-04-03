import { TileLayer, TileLayerProps } from '@deck.gl/geo-layers'
import { H3HexagonLayer } from '@deck.gl/geo-layers'
import { load } from '@loaders.gl/core'
// @ts-expect-error no types available
import { ArrowLoader } from '@loaders.gl/arrow'
import H3Tileset2D, { type H3TileIndex } from './vendor/h3-tileset-2d'
import * as h3 from 'h3-js'
import * as d3 from 'd3'

interface ArrowColumnarData {
  data: {
    index: string[]
    value: number[]
  }
  numRows: number
}

interface ArrowH3TileLayerProps extends Omit<TileLayerProps<ArrowColumnarData>, 'data'> {
  data: (tileInfo: { h3Index: string; resolution: number }) => Response | Promise<Response>
}

const colourRamp = d3.scaleSequential(d3.interpolateSpectral).domain([0, 100])
const getColour = (v: number): [number, number, number, number] => {
  const c = d3.color(colourRamp(v))!
  const rgb = c.formatRgb().match(/[\d.]+/g)!.map(Number)
  return [rgb[0], rgb[1], rgb[2], Math.sqrt(v) * 255]
}

export class ArrowH3TileLayer extends TileLayer<ArrowColumnarData> {
  static defaultProps = {
    TilesetClass: H3Tileset2D,
  }

  static layerName = 'ArrowH3TileLayer'

  // @ts-expect-error TileLoadProps uses TileIndex but we use H3TileIndex
  getTileData(tile: { index: H3TileIndex }): Promise<ArrowColumnarData> {
    const h3Index = tile.index.i
    const resolution = h3.getResolution(tile.index.i)
    const response = (this.props as unknown as ArrowH3TileLayerProps).data({ h3Index, resolution })

    // @ts-expect-error loaders.gl/arrow has no type declarations
    const data = load(response, ArrowLoader, {
      arrow: {
        shape: 'columnar-table',
      },
    })
    return data as Promise<ArrowColumnarData>
  }

  renderSubLayers(props: any) {
    const { data, tile } = props

    if (!data || data.numRows === 0) return null

    const h3Indices = data.data.index
    const values = data.data.value

    return new H3HexagonLayer({
      ...props,
      id: `${props.id}-${tile.index.i}`,
      data: { length: values.length },

      getHexagon: (_d: unknown, { index }: { index: number }) => h3Indices.at(index)!.toString(16),

      getFillColor: (_d: unknown, { index }: { index: number }) => getColour(values.at(index)!),

      updateTriggers: {
        getHexagon: [h3Indices],
        getFillColor: [values],
      },
      opacity: 1,
      extruded: false,
      stroked: false,
    })
  }
}
