
export function asBoolean(input: string | number | boolean): boolean {
    if (input === true || input === false) {
        return input
    } else {
        return Boolean(parseInt(String(input)))
    }
}

export function asStringList(input: string | string[]): string[] {
    if (Array.isArray(input)) {
        return input
    } else {
        return input
            .split(',')
            .map(item => item.trim())
            .filter(item => item.length > 0)
    }
}

function isDate(input: unknown): input is Date {
    return input instanceof Date
}

export function asDate(input: string | number | Date): Date {
    if (isDate(input)) {
        return input
    } else {
        return new Date(input)
    }
}
