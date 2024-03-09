
export async function sha256Encode(text: string) {
    const rawText = new TextEncoder().encode(text)
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', rawText))]
        .map(x => parseInt(x).toString(16).padStart(2, '0'))
        .join('')
}
