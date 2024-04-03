import {MaybeRefOrGetter, ref, toValue, watchEffect} from "vue";

export function useDurationFormat(duration: MaybeRefOrGetter<number>) {
    const formatted = ref('')

    watchEffect(() => {
        let rawDuration = toValue(duration)

        const totalHours = Math.floor(rawDuration / (60 * 60)) || null
        rawDuration -= totalHours * (60 * 60)
        const totalMinutes = Math.floor(rawDuration / 60)
        rawDuration -= totalMinutes * 60
        const totalSeconds = Math.round(1 * rawDuration)

        formatted.value = [totalHours, totalMinutes, String(totalSeconds).padStart(2, '0')]
            .filter(time => time !== null)
            .join(':')
    })

    return formatted
}
