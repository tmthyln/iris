import {ref, computed, Ref} from 'vue'

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

function generatePlaceholderSvg(name: string, size: number = 128): string {
  const letter = (name?.[0] ?? '?').toUpperCase()
  const hue = hashString(name ?? '') % 360
  const color = `hsl(${hue}, 65%, 45%)`
  const fontSize = Math.round(size / 2)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect width="${size}" height="${size}" fill="${color}"/>
    <text x="${size/2}" y="${size/2}" dominant-baseline="central" text-anchor="middle"
          font-family="system-ui, sans-serif" font-size="${fontSize}" font-weight="bold" fill="white">
      ${letter}
    </text>
  </svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function usePlaceholderImage(imageSrc: Ref<string | null | undefined>, name: Ref<string>, size: number = 128) {
  const imageError = ref(false)

  const placeholderSvg = computed(() => generatePlaceholderSvg(name.value, size))

  const resolvedSrc = computed(() => {
    if (imageError.value || !imageSrc.value) {
      return placeholderSvg.value
    }
    return imageSrc.value
  })

  function onImageError() {
    imageError.value = true
  }

  return {
    resolvedSrc,
    onImageError,
  }
}