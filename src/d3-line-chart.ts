import * as d3 from 'd3'

interface Dataset {
    name: string
    values: number[]
    /** Optional x-values for each y-value. If not provided, labels or indices are used. */
    xValues?: number[]
}

interface ChartData {
    labels?: string[]
    datasets: Dataset[]
}

interface ChartOptions {
    type?: string
    height?: number
    title?: string
    colors?: string[]
    axisOptions?: {
        xIsSeries?: boolean
        xAxisMode?: string
        yAxisMode?: string
    }
    lineOptions?: {
        hideDots?: number
    }
    animate?: boolean
}

export class D3LineChart {
    private container: HTMLElement
    private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>
    private margin = { top: 40, right: 20, bottom: 60, left: 60 }
    private width: number
    private height: number
    private colors: string[] = []
    private lastData: ChartData | null = null
    private lastOptions: ChartOptions | null = null
    private resizeObserver: ResizeObserver
    private tooltip: d3.Selection<HTMLDivElement, unknown, null, undefined>

    constructor(container: HTMLElement, options: { data: ChartData } & ChartOptions) {
        this.container = container
        this.height = options.height || 300
        this.width = container.clientWidth || 600

        container.innerHTML = ''
        container.style.position = 'relative'
        container.style.overflow = 'visible'

        this.svg = d3.select(container)
            .append('svg')
            .attr('width', '100%')
            .attr('height', this.height)
            .attr('viewBox', `0 0 ${this.width} ${this.height}`)
            .style('display', 'block')
            .style('overflow', 'visible')

        this.tooltip = d3.select(container).append('div')
            .style('position', 'absolute')
            .style('visibility', 'hidden')
            .style('background-color', 'rgba(255, 255, 255, 0.95)')
            .style('border', '1px solid #ddd')
            .style('padding', '5px')
            .style('border-radius', '3px')
            .style('font-size', '12px')
            .style('pointer-events', 'none')
            .style('z-index', '1000')
            .style('box-shadow', '0 2px 4px rgba(0,0,0,0.1)')
            .style('white-space', 'nowrap')

        this.resizeObserver = new ResizeObserver(() => {
            if (this.lastData) {
                this.update(this.lastData, this.lastOptions || {})
            }
        })
        this.resizeObserver.observe(container)

        this.update(options.data, options)
    }

    update(data: ChartData, options: ChartOptions = {}) {
        this.lastData = data
        this.lastOptions = options
        const { labels, datasets } = data
        const width = this.container.clientWidth || 600
        const height = options.height || this.height
        this.width = width
        this.height = height
        this.colors = options.colors || ['#ff69b4', '#ffa500', '#41c6ff', '#7cfc00', '#ff4500', '#9370db', '#00ced1', '#ffd700']

        this.svg
            .attr('viewBox', `0 0 ${width} ${height}`)
            .attr('height', height)

        this.svg.selectAll('*').remove()

        const g = this.svg.append('g')
            .attr('transform', `translate(${this.margin.left},${this.margin.top})`)

        const innerWidth = width - this.margin.left - this.margin.right
        const innerHeight = height - this.margin.top - this.margin.bottom

        // Title
        if (options.title) {
            this.svg.append('text')
                .attr('x', width / 2)
                .attr('y', 20)
                .attr('text-anchor', 'middle')
                .style('font-size', '14px')
                .style('font-weight', 'bold')
                .text(options.title)
        }

        // Scales
        let x: d3.ScaleLinear<number, number> | d3.ScalePoint<string>

        // Determine if we should use a linear scale for X
        const hasXValues = datasets.some(d => d.xValues && d.xValues.length > 0)
        const numericLabels = labels && labels.every(l => !isNaN(parseFloat(l)))
        const isLinear = hasXValues || numericLabels

        if (isLinear) {
            let xMin = Infinity
            let xMax = -Infinity
            if (hasXValues) {
                datasets.forEach(d => {
                    const vals = d.xValues || (labels ? labels.map(parseFloat) : d.values.map((_, i) => i))
                    const [min, max] = d3.extent(vals)
                    if (min !== undefined) xMin = Math.min(xMin, min)
                    if (max !== undefined) xMax = Math.max(xMax, max)
                })
            } else if (numericLabels) {
                const vals = labels!.map(parseFloat)
                const [min, max] = d3.extent(vals)
                if (min !== undefined) xMin = min
                if (max !== undefined) xMax = max
            }
            if (xMin === Infinity) { xMin = 0; xMax = 1 }

            x = d3.scaleLinear()
                .domain([xMin, xMax])
                .range([0, innerWidth])
        } else {
            x = d3.scalePoint()
                .domain(labels || [])
                .range([0, innerWidth])
        }

        const allValues = datasets.flatMap(d => d.values)
        const yMin = 0
        const yMax = d3.max(allValues) || 0

        const y = d3.scaleLinear()
            .domain([yMin, yMax]).nice()
            .range([innerHeight, 0])

        // Axes
        let xAxis: d3.Axis<any>
        if (isLinear) {
            xAxis = d3.axisBottom(x as d3.ScaleLinear<number, number>)
                .ticks(10)
                .tickFormat(d3.format(".1f"))
        } else {
            const pointX = x as d3.ScalePoint<string>
            xAxis = d3.axisBottom(pointX)
                .tickValues(pointX.domain().filter((d, i) => {
                    const step = Math.ceil(pointX.domain().length / 10)
                    return i % step === 0 || i === pointX.domain().length - 1
                }))
        }

        const yAxis = d3.axisLeft(y)
            .ticks(5)
            .tickFormat(d3.format('.2s'))

        g.append('g')
            .attr('transform', `translate(0,${innerHeight})`)
            .call(xAxis)
            .selectAll('text')
            .style('font-size', '10px')

        g.append('g')
            .call(yAxis)
            .selectAll('text')
            .style('font-size', '10px')

        // Grid lines (horizontal)
        g.append('g')
            .attr('class', 'grid')
            .call(d3.axisLeft(y)
                .ticks(5)
                .tickSize(-innerWidth)
                .tickFormat(() => '')
            )
            // .style('stroke', '#eee')
            .style('stroke-dasharray', '2,2')
            .select('.domain').remove()

        this.tooltip.style('visibility', 'hidden')

        // Lines
        const line = d3.line<{ x: number, y: number }>()
            .x(d => (isLinear ? (x as d3.ScaleLinear<number, number>)(d.x) : (x as d3.ScalePoint<string>)(String(d.x)))!)
            .y(d => y(d.y))

        // Pre-calculate line data for all datasets for easier access in tooltip
        const allDatasetsData = datasets.map((dataset, i) => {
            return dataset.values.map((v, j) => {
                let xv: any
                if (dataset.xValues) {
                    xv = dataset.xValues[j]
                } else if (numericLabels) {
                    xv = parseFloat(labels![j])
                } else if (labels) {
                    xv = labels[j]
                } else {
                    xv = j
                }
                return { x: xv, y: v, name: dataset.name, color: this.colors[i % this.colors.length] }
            })
        })

        datasets.forEach((dataset, i) => {
            const color = this.colors[i % this.colors.length]
            const lineData = allDatasetsData[i]

            g.append('path')
                .datum(lineData)
                .attr('fill', 'none')
                .attr('stroke', color)
                .attr('stroke-width', 2)
                .attr('d', line as any)

            // Visible points (if not hidden)
            if (!options.lineOptions?.hideDots) {
                g.selectAll(`.dot-${i}`)
                    .data(lineData)
                    .enter()
                    .append('circle')
                    .attr('cx', d => (isLinear ? (x as d3.ScaleLinear<number, number>)(d.x) : (x as d3.ScalePoint<string>)(String(d.x)))!)
                    .attr('cy', d => y(d.y))
                    .attr('r', 3)
                    .attr('fill', color)
            }
        })

        // Overlay for better tooltip interaction
        const hoverLine = g.append('line')
            .attr('y1', 0)
            .attr('y2', innerHeight)
            .attr('stroke', '#ddd')
            .attr('stroke-width', 1)
            .attr('stroke-dasharray', '4,4')
            .style('visibility', 'hidden')

        const hoverPoints = g.selectAll('.hover-point')
            .data(datasets)
            .enter()
            .append('circle')
            .attr('class', 'hover-point')
            .attr('r', 4)
            .attr('fill', (d, i) => this.colors[i % this.colors.length])
            .attr('stroke', '#fff')
            .attr('stroke-width', 1)
            .style('visibility', 'hidden')

        const overlay = g.append('rect')
            .attr('width', innerWidth)
            .attr('height', innerHeight)
            .attr('fill', 'transparent')
            .style('pointer-events', 'all')

        const bisect = d3.bisector((d: any) => d.x).left

        overlay
            .on('mousemove', (event) => {
                const [mouseX] = d3.pointer(event)
                let xValue: any

                if (isLinear) {
                    xValue = (x as d3.ScaleLinear<number, number>).invert(mouseX)
                } else {
                    // Find nearest point in the point scale
                    const domain = (x as d3.ScalePoint<string>).domain()
                    const step = (x as d3.ScalePoint<string>).step()
                    const index = Math.round(mouseX / step)
                    xValue = domain[Math.min(domain.length - 1, Math.max(0, index))]
                }

                const pointsAtX = allDatasetsData.map(data => {
                    if (isLinear) {
                        const idx = bisect(data, xValue)
                        const d0 = data[idx - 1]
                        const d1 = data[idx]
                        if (!d0) return d1
                        if (!d1) return d0
                        return (xValue - d0.x > d1.x - xValue) ? d1 : d0
                    } else {
                        return data.find(d => String(d.x) === String(xValue))
                    }
                }).filter(Boolean) as any[]

                if (pointsAtX.length > 0) {
                    // Find the single closest point overall across all datasets to determine snapping X
                    let closestPointOverall = pointsAtX[0]
                    let minDiffOverall = Infinity

                    pointsAtX.forEach(p => {
                        const px = (isLinear ? (x as d3.ScaleLinear<number, number>)(p.x) : (x as d3.ScalePoint<string>)(String(p.x)))!
                        const diff = Math.abs(px - mouseX)
                        if (diff < minDiffOverall) {
                            minDiffOverall = diff
                            closestPointOverall = p
                        }
                    })

                    const cx = (isLinear ? (x as d3.ScaleLinear<number, number>)(closestPointOverall.x) : (x as d3.ScalePoint<string>)(String(closestPointOverall.x)))!

                    hoverLine
                        .attr('x1', cx)
                        .attr('x2', cx)
                        .style('visibility', 'visible')

                    hoverPoints
                        .attr('cx', (d, i) => {
                            const p = pointsAtX[i]
                            const val = p ? (isLinear ? (x as d3.ScaleLinear<number, number>)(p.x) : (x as d3.ScalePoint<string>)(String(p.x))) : 0
                            return val ?? 0
                        })
                        .attr('cy', (d, i) => {
                            const p = pointsAtX[i]
                            return p ? y(p.y) : 0
                        })
                        .style('visibility', (d, i) => pointsAtX[i] ? 'visible' : 'hidden')

                    const [px, py] = d3.pointer(event, this.container)
                    this.tooltip.style('visibility', 'visible')
                        .style('top', (py - 10) + 'px')
                        .style('left', (px + 10) + 'px')
                        .html(`
                            ${pointsAtX.map(p => `
                                <div style="display: flex; align-items: center; gap: 5px; margin-bottom: 2px;">
                                    <div style="width: 8px; height: 8px; background-color: ${p.color};"></div>
                                    <span style="color: ${p.color}">${p.name}:</span>
                                    <span style="font-weight: bold;">${typeof p.y === 'number' ? p.y.toLocaleString() : p.y}</span>
                                    <span style="font-size: 0.9em; color: #888;">&nbsp;(@ ${typeof p.x === 'number' ? p.x.toFixed(2) : p.x} km)</span>
                                </div>
                            `).join('')}
                        `)
                }
            })
            .on('mouseout', () => {
                hoverLine.style('visibility', 'hidden')
                hoverPoints.style('visibility', 'hidden')
                this.tooltip.style('visibility', 'hidden')
            })

        // Legend (basic)
        if (datasets.length > 1 || (datasets.length === 1 && datasets[0].name !== 'Dataset')) {
            const legend = this.svg.append('g')
                .attr('transform', `translate(${this.margin.left}, ${height - this.margin.bottom + 25})`)

            let currentX = 0
            let currentY = 0
            const rowHeight = 15
            datasets.forEach((dataset, i) => {
                const color = this.colors[i % this.colors.length]
                const itemWidth = dataset.name.length * 7 + 25 // Approximate width

                if (currentX + itemWidth > innerWidth && i > 0) {
                    currentX = 0
                    currentY += rowHeight
                }

                const legendItem = legend.append('g')
                    .attr('transform', `translate(${currentX}, ${currentY})`)

                legendItem.append('rect')
                    .attr('width', 10)
                    .attr('height', 10)
                    .attr('fill', color)

                legendItem.append('text')
                    .attr('x', 15)
                    .attr('y', 9)
                    .style('font-size', '10px')
                    .text(dataset.name)

                currentX += itemWidth
            })
        }
    }
}
