export function unixEpoch(timestamp: string) {
    const millis = new Date(timestamp).getTime() / 1000
    return Math.round(millis)
}