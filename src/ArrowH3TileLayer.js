import { TileLayer } from '@deck.gl/geo-layers';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { load } from '@loaders.gl/core';
import { ArrowLoader } from '@loaders.gl/arrow';
import H3Tileset2D from './vendor/h3-tileset-2d'
import * as h3 from 'h3-js'
import * as d3 from 'd3'

const colourRamp = d3.scaleSequential(d3.interpolateSpectral).domain([0,100])
const getColour = v => [...Object.values(d3.color(colourRamp(v))).slice(0,-1), Math.sqrt(v)*255] // with v as alpha too

export class ArrowH3TileLayer extends TileLayer {
  
  getTileData(tile) {
    const h3Index = tile.index.i;
    const resolution = h3.getResolution(tile.index.i)
    // const url = this.props.data.replace(/\{h3Index\}/g, h3Index).replace(/\{resolution\}/g, resolution);
    const maybeFetch = this.props.data({h3Index, resolution})

    const data = load(maybeFetch, ArrowLoader, {
      arrow: {
        shape: 'columnar-table'
      }
    });
    return data
  }

  renderSubLayers(props) {
    const { data } = props;
    const { tile } = props;

    if (!data || data.numRows === 0) return null;

    const h3Indices = data.data.index; // todo: use uint64 instead of string
    const values = data.data.value;

    return new H3HexagonLayer(props, {
      id: `${props.id}-${tile.index.i}`,
      data: { length: values.length }, // ?
      
      getHexagon: (d, { index }) => { return h3Indices.at(index).toString(16) },
      
      getFillColor: (d, { index }) => getColour(values.at(index)),
      // getFillColor: (d, { index }) => { console.log(d); return [0, 0, 0] } ,
      
      updateTriggers: {
        getHexagon: [h3Indices],
        getFillColor: [values]
      },
      opacity: 1,
      extruded: false,
      stroked: false,
    });
  }
}

ArrowH3TileLayer.defaultProps = {
  TilesetClass: H3Tileset2D, 
};

ArrowH3TileLayer.layerName = 'ArrowH3TileLayer';
