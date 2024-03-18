import fs from 'node:fs'

const size = 200
const margin = 10
const r = (size - margin) / 4

function shear([x, y]) {
    return [x, y + x/2]
}
function scale([x, y]) {
    return [r*x, r*y]
}
function flipVertical([x, y]) {
    return [x, -y]
}
const polygons = [
    // hexagon side segments
    [[-2, -2], [-2, -1], [-1, 0], [-1, -2]],
    [[-2, 0], [-1, 1], [0, 1], [-2, -1]],
    [[0, 2], [1, 2], [1, 1], [-1, 1]],
    [[2, 2], [2, 1], [1, 0], [1, 2]],
    // arrow
    [[0, -2], [-1, -2], [-1/2, -3/2], [-1/2, 1/2], [0, 1], [1/2, 1], [1/2, -1], [1, -1]],
]
    .map(
        points => points
            .map(flipVertical)
            .map(scale)
            .map(shear)
            .map(([x, y]) => `${x},${y}`)
            .join(' ')
    )

export const generatedSvg = ` 
<svg height="${size}" width="${size}" viewBox="${-size/2} ${-size/2} ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <polygon points="${polygons[0]}" fill="#e6274d"/>
    <polygon points="${polygons[1]}" fill="#ed7032"/>
    <polygon points="${polygons[2]}" fill="#aced32"/>
    <polygon points="${polygons[3]}" fill="#4c6ffc"/>
    <polygon points="${polygons[4]}" fill="#35e871"/>
</svg>
`.trim()

fs.writeFile('src/assets/icon.svg', generatedSvg, err => {
    if (err) {
        console.error(err)
    }
})
