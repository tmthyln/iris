
export function asBoolean(input: string | number | boolean): boolean {
    if (input === true || input === false) {
        return input as boolean
    } else {
        return Boolean(parseInt(String(input)))
    }
}

export function asStringList(input: string | string[]): string[] {
    if (Array.isArray(input)) {
        return input as string[]
    } else {
        return input
            .split(',')
            .map(item => item.trim())
            .filter(item => item.length > 0)
    }
}

function isDate(unknown: any): unknown is Date {
    return unknown instanceof Date
}

export function asDate(input: string | number | Date): Date {
    if (isDate(input)) {
        return input as Date
    } else {
        return new Date(input)
    }
}
