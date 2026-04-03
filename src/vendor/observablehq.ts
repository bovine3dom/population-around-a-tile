// Copyright 2021, Observable Inc.
// Released under the ISC license.
// https://observablehq.com/@d3/color-legend
import * as d3 from 'd3'

interface LegendOptions {
    title?: string
    tickSize?: number
    width?: number
    height?: number
    marginTop?: number
    marginRight?: number
    marginBottom?: number
    marginLeft?: number
    ticks?: number
    tickFormat?: string | ((v: number) => string)
    tickValues?: number[]
}

interface SwatchOptions {
    columns?: string | null
    format?: (v: unknown) => string
    unknown?: string
    swatchSize?: number
    swatchWidth?: number
    swatchHeight?: number
    marginLeft?: number
}

function ramp(color: d3.ScaleSequential<string>, n = 256): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.width = n
    canvas.height = 1
    const context = canvas.getContext('2d')!
    for (let i = 0; i < n; ++i) {
        context.fillStyle = color(i / (n - 1))
        context.fillRect(i, 0, 1, 1)
    }
    return canvas
}

function Legend(
    color: d3.ScaleSequential<string> | d3.ScaleThreshold<number, string> | d3.ScaleOrdinal<string, string>,
    {
        title,
        tickSize = 6,
        width = 320,
        height = 44 + tickSize,
        marginTop = 18,
        marginRight = 0,
        marginBottom = 16 + tickSize,
        marginLeft = 0,
        ticks = width / 64,
        tickFormat,
        tickValues,
    }: LegendOptions = {}
): SVGSVGElement {
    const svg = d3.create('svg')
        .attr('width', width)
        .attr('height', height)
        .attr('viewBox', [0, 0, width, height])
        .style('overflow', 'visible')
        .style('display', 'block')

    let tickAdjust = (g: d3.Selection<SVGGElement, unknown, null, undefined>) =>
        g.selectAll('.tick line').attr('y1', marginTop + marginBottom - height)
    let x: d3.ScaleLinear<number, number> | d3.ScaleBand<string> | undefined

    // Sequential
    if ('interpolator' in color) {
        const seqColor = color as unknown as d3.ScaleSequential<number, number>
        x = Object.assign(
            seqColor.copy().interpolator(d3.interpolateRound(marginLeft, width - marginRight)),
            { range(): [number, number] { return [marginLeft, width - marginRight] } }
        ) as unknown as d3.ScaleLinear<number, number>

        svg.append('image')
            .attr('x', marginLeft)
            .attr('y', marginTop)
            .attr('width', width - marginLeft - marginRight)
            .attr('height', height - marginTop - marginBottom)
            .attr('preserveAspectRatio', 'none')
            .attr('xlink:href', ramp(color as d3.ScaleSequential<string>).toDataURL())

        if (!(x as d3.ScaleLinear<number, number>).ticks) {
            if (tickValues === undefined) {
                const n = Math.round(ticks + 1)
                const domain = color.domain() as number[]
                tickValues = d3.range(n).map(i => d3.quantile(domain, i / (n - 1))!)
            }
            if (typeof tickFormat !== 'function') {
                tickFormat = d3.format(typeof tickFormat === 'string' ? tickFormat : ',f')
            }
        }
    }
    // Threshold
    else if ('invertExtent' in color) {
        const thresholds = (color as any).thresholds
            ? (color as any).thresholds()
            : (color as any).quantiles
                ? (color as any).quantiles()
                : color.domain()

        const thresholdFormat =
            tickFormat === undefined
                ? (d: number) => String(d)
                : typeof tickFormat === 'string'
                    ? d3.format(tickFormat)
                    : tickFormat

        x = d3.scaleLinear()
            .domain([-1, color.range().length - 1])
            .rangeRound([marginLeft, width - marginRight])

        svg.append('g')
            .selectAll('rect')
            .data(color.range())
            .join('rect')
            .attr('x', (_d, i) => (x as d3.ScaleLinear<number, number>)(i - 1))
            .attr('y', marginTop)
            .attr('width', (_d, i) => (x as d3.ScaleLinear<number, number>)(i) - (x as d3.ScaleLinear<number, number>)(i - 1))
            .attr('height', height - marginTop - marginBottom)
            .attr('fill', d => d)

        tickValues = d3.range(thresholds.length)
        tickFormat = (i: number) => thresholdFormat(thresholds[i] as number)
    }
    // Ordinal
    else {
        const bandScale = d3.scaleBand()
            .domain(color.domain())
            .rangeRound([marginLeft, width - marginRight])
        x = bandScale

        svg.append('g')
            .selectAll('rect')
            .data(color.domain())
            .join('rect')
            .attr('x', d => bandScale(d)!)
            .attr('y', marginTop)
            .attr('width', Math.max(0, bandScale.bandwidth() - 1))
            .attr('height', height - marginTop - marginBottom)
            .attr('fill', d => (color as d3.ScaleOrdinal<string, string>)(d))

        tickAdjust = (g: d3.Selection<SVGGElement, unknown, null, undefined>) => g as any
    }

    const axis = d3.axisBottom(x as d3.ScaleLinear<number, number>)
        .ticks(ticks, typeof tickFormat === 'string' ? tickFormat : undefined)
        .tickSize(tickSize)

    if (typeof tickFormat === 'function') {
        axis.tickFormat(tickFormat as (domainValue: d3.NumberValue, index: number) => string)
    }
    if (tickValues) {
        axis.tickValues(tickValues)
    }

    svg.append('g')
        .attr('transform', `translate(0,${height - marginBottom})`)
        .call(axis)
        .call(tickAdjust as any)
        .call(g => g.select('.domain').remove())
        .call(g =>
            g.append('text')
                .attr('x', marginLeft)
                .attr('y', marginTop + marginBottom - height - 6)
                .attr('fill', 'currentColor')
                .attr('text-anchor', 'start')
                .attr('font-weight', 'bold')
                .attr('class', 'title')
                .text(title ?? '')
        )

    return svg.node()!
}

export function legend(options: { color: d3.ScaleSequential<string> | d3.ScaleThreshold<number, string> | d3.ScaleOrdinal<string, string> } & LegendOptions): SVGSVGElement {
    const { color, ...rest } = options
    return Legend(color, rest)
}

export function swatches(options: { color: d3.ScaleOrdinal<string, string> } & SwatchOptions): HTMLElement {
    const { color, ...rest } = options
    return Swatches(color, rest)
}

function Swatches(
    color: d3.ScaleOrdinal<string, string>,
    {
        columns = null,
        format,
        unknown: formatUnknown,
        swatchSize = 15,
        swatchWidth = swatchSize,
        swatchHeight = swatchSize,
        marginLeft = 0,
    }: SwatchOptions = {}
): HTMLElement {
    const id = `-swatches-${Math.random().toString(16).slice(2)}`
    const unknown = formatUnknown == null ? undefined : color.unknown()
    const unknowns = unknown == null || unknown === d3.scaleImplicit ? [] : [unknown]
    const domain = [...color.domain(), ...(unknowns as unknown as string[])]
    const fmt = format ?? ((x: unknown) => x === unknown ? formatUnknown ?? String(x) : String(x))

    if (columns !== null) {
        const container = document.createElement('div')
        container.style.cssText = `display: flex; align-items: center; margin-left: ${marginLeft}px; min-height: 33px; font: 10px sans-serif;`

        const style = document.createElement('style')
        style.textContent = `
.${id}-item { break-inside: avoid; display: flex; align-items: center; padding-bottom: 1px; }
.${id}-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: calc(100% - ${swatchWidth}px - 0.5em); }
.${id}-swatch { width: ${swatchWidth}px; height: ${swatchHeight}px; margin: 0 0.5em 0 0; }
`
        container.appendChild(style)

        const columnsDiv = document.createElement('div')
        columnsDiv.style.width = '100%'
        columnsDiv.style.columns = columns

        for (const value of domain) {
            const label = fmt(value)
            const item = document.createElement('div')
            item.className = `${id}-item`

            const swatch = document.createElement('div')
            swatch.className = `${id}-swatch`
            swatch.style.background = color(value)

            const labelDiv = document.createElement('div')
            labelDiv.className = `${id}-label`
            labelDiv.title = label
            labelDiv.textContent = label

            item.appendChild(swatch)
            item.appendChild(labelDiv)
            columnsDiv.appendChild(item)
        }

        container.appendChild(columnsDiv)
        return container
    }

    const container = document.createElement('div')
    container.style.cssText = `display: flex; align-items: center; min-height: 33px; margin-left: ${marginLeft}px; font: 10px sans-serif;`

    const style = document.createElement('style')
    style.textContent = `
.${id} { display: inline-flex; align-items: center; margin-right: 1em; }
.${id}::before { content: ""; width: ${swatchWidth}px; height: ${swatchHeight}px; margin-right: 0.5em; background: var(--color); }
`
    container.appendChild(style)

    const inner = document.createElement('div')
    for (const value of domain) {
        const span = document.createElement('span')
        span.className = id
        span.style.setProperty('--color', color(value))
        span.textContent = fmt(value)
        inner.appendChild(span)
    }
    container.appendChild(inner)
    return container
}
