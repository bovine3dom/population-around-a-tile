// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import { _Tileset2D as Tileset2D, type GeoBoundingBox } from '@deck.gl/geo-layers'
import {
  polygonToCells,
  latLngToCell,
  getResolution,
  cellToBoundary,
  cellToParent,
  gridDisk,
  edgeLength,
  UNITS,
  originToDirectedEdges
} from 'h3-js'

export type H3TileIndex = { i: string }

const MAX_LATITUDE = 85.051128

function padBoundingBox(
  { west, north, east, south }: GeoBoundingBox,
  resolution: number,
  scale = 1.0
): GeoBoundingBox {
  const corners: [number, number][] = [
    [north, east],
    [south, east],
    [south, west],
    [north, west]
  ]
  const cornerCells = corners.map(c => latLngToCell(c[0], c[1], resolution))
  const cornerEdgeLengths = cornerCells.map(
    c => (Math.max(...originToDirectedEdges(c).map((e: string) => edgeLength(e, UNITS.rads))) * 180) / Math.PI
  )
  const bufferLat = Math.max(...cornerEdgeLengths) * scale
  const bufferLon = Math.min(180, bufferLat / Math.cos((((north + south) / 2) * Math.PI) / 180))

  return {
    north: Math.min(north + bufferLat, MAX_LATITUDE),
    east: east + bufferLon,
    south: Math.max(south - bufferLat, -MAX_LATITUDE),
    west: west - bufferLon
  }
}

function getHexagonsInBoundingBox(
  { west, north, east, south }: GeoBoundingBox,
  resolution: number
): string[] {
  const longitudeSpan = Math.abs(east - west)
  if (longitudeSpan > 180) {
    const nSegments = Math.ceil(longitudeSpan / 180)
    let h3Indices: string[] = []
    for (let s = 0; s < nSegments; s++) {
      const segmentWest = west + s * 180
      const segmentEast = Math.min(segmentWest + 179.9999999, east)
      h3Indices = h3Indices.concat(
        getHexagonsInBoundingBox({ west: segmentWest, north, east: segmentEast, south }, resolution)
      )
    }
    return [...new Set(h3Indices)]
  }

  const polygon: [number, number][] = [
    [north, east],
    [south, east],
    [south, west],
    [north, west],
    [north, east]
  ]
  return polygonToCells(polygon, resolution)
}

function tileToBoundingBox(index: string): GeoBoundingBox {
  const coordinates = cellToBoundary(index)
  const latitudes = coordinates.map((c: number[]) => c[0])
  const longitudes = coordinates.map((c: number[]) => c[1])
  const west = Math.min(...longitudes)
  const south = Math.min(...latitudes)
  const east = Math.max(...longitudes)
  const north = Math.max(...latitudes)
  const bbox = { west, south, east, north }

  return padBoundingBox(bbox, getResolution(index), 0.12)
}

const BIAS = 2;
export function getHexagonResolution(
  viewport: { zoom: number; latitude: number },
  tileSize: number,
  resBias: number = 0
): number {
  const zoomOffset = Math.log2(tileSize / 512);
  const h3ScaleFactor = 2 / Math.log2(7); // ~0.7124
  const latRad = (Math.PI * viewport.latitude) / 180;
  const latitudeAdjustment = Math.log2(1 / Math.cos(latRad));
  const BIAS = 2; // Default bias
  const exactResolution = h3ScaleFactor * (viewport.zoom - zoomOffset + latitudeAdjustment) - (BIAS - resBias);
  const MY_MAX_TILE_SIZE = 5 // 15
  return Math.max(0, Math.min(MY_MAX_TILE_SIZE, Math.floor(exactResolution))); // i don't like hacking this in here but whatever
}

// const BIAS = 5
// export function getHexagonResolution(
//   viewport: { zoom: number; latitude: number },
//   tileSize: number
// ): number {
//   const zoomOffset = Math.log2(tileSize / 512)
//   const hexagonScaleFactor = (2 / 3) * (viewport.zoom - zoomOffset)
//   const latitudeScaleFactor = Math.log(1 / Math.cos((Math.PI * viewport.latitude) / 180))

//   const vanilla_zoom = Math.max(0, Math.floor(hexagonScaleFactor + latitudeScaleFactor - BIAS))
//   return vanilla_zoom
//   // return Math.max(0, Math.floor((vanilla_zoom + 1) / 2) * 2 - 1) // odd only
// }

// Tileset2D is not generic over TileIndex, so we need to suppress type errors
// when overriding methods that use our custom H3TileIndex type.
export default class H3Tileset2D extends Tileset2D {
  // @ts-expect-error Tileset2D uses TileIndex (x,y,z) but we use H3TileIndex ({i: string})
  getTileIndices({ viewport, minZoom, maxZoom }: { viewport: { latitude?: number; longitude: number; zoom: number; getBounds(): [number, number, number, number] }; minZoom?: number; maxZoom?: number }): H3TileIndex[] {
    if (viewport.latitude === undefined) return []
    const [west, south, east, north] = viewport.getBounds()
    const { tileSize, resBias = 0 } = this.opts as { tileSize: number; resBias?: number }

    let z = getHexagonResolution({ zoom: viewport.zoom, latitude: viewport.latitude }, tileSize, resBias)
    let indices: string[]
    if (typeof minZoom === 'number' && Number.isFinite(minZoom) && z < minZoom) {
      return []
    }
    if (typeof maxZoom === 'number' && Number.isFinite(maxZoom) && z > maxZoom) {
      z = maxZoom
    }
    const paddedBounds = padBoundingBox({ west, north, east, south }, z)
    indices = getHexagonsInBoundingBox(paddedBounds, z)

    return indices.map(i => ({ i }))
  }

  // @ts-expect-error Tileset2D uses TileIndex but we use H3TileIndex
  getTileId({ i }: H3TileIndex): string {
    return i
  }

  // @ts-expect-error Tileset2D uses TileIndex but we use H3TileIndex
  getTileMetadata({ i }: H3TileIndex): { bbox: GeoBoundingBox } {
    return { bbox: tileToBoundingBox(i) }
  }

  // @ts-expect-error Tileset2D uses TileIndex but we use H3TileIndex
  getTileZoom({ i }: H3TileIndex): number {
    return getResolution(i)
  }

  // @ts-expect-error Tileset2D uses TileIndex but we use H3TileIndex
  getParentIndex(index: H3TileIndex): H3TileIndex {
    const resolution = getResolution(index.i)
    const i = cellToParent(index.i, resolution - 1)
    return { i }
  }
}
