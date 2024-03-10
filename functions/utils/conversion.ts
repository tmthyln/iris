
export function asBoolean(input: string | number | boolean | null): boolean | null {
    if (input === null || input === true || input === false) {
        return input as boolean | null
    } else {
        return Boolean(parseInt(String(input)))
    }
}

export function asStringList(input: string | string[] | null): string[] | null {
    if (input === null || Array.isArray(input)) {
        return input as string[] | null
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

export function asDate(input: string | number | Date | null): Date | null {
    if (input === null || isDate(input)) {
        return input as Date | null
    } else {
        return new Date(input)
    }
}
