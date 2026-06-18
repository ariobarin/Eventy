export function createPasteAutoValidator({
    triggerValidate,
    debounceMs = 150,
    minLength = 8,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
}) {
    if (typeof triggerValidate !== "function") {
        throw new TypeError("triggerValidate must be a function");
    }

    let timerId = null;

    return function handleAutoValidate(event, value) {
        const isPasteEvent =
            event?.inputType === "insertFromPaste" || event?.type === "paste";

        if (!isPasteEvent) {
            return false;
        }

        const trimmedValue = (value ?? "").trim();
        if (trimmedValue.length < minLength) {
            return false;
        }

        if (timerId) {
            clearTimeoutFn(timerId);
        }

        timerId = setTimeoutFn(() => {
            timerId = null;
            triggerValidate();
        }, debounceMs);

        return true;
    };
}

export function attachApiKeyAutoValidation({
    inputEl,
    triggerValidate,
    debounceMs = 150,
    minLength = 8,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
}) {
    if (!inputEl || typeof inputEl.addEventListener !== "function") {
        return () => {};
    }

    const handler = createPasteAutoValidator({
        triggerValidate,
        debounceMs,
        minLength,
        setTimeoutFn,
        clearTimeoutFn,
    });

    const onInput = (event) => handler(event, inputEl.value);
    const onPaste = (event) => {
        setTimeoutFn(() => handler(event, inputEl.value), 0);
    };

    inputEl.addEventListener("input", onInput);
    inputEl.addEventListener("paste", onPaste);

    return () => {
        if (typeof inputEl.removeEventListener !== "function") {
            return;
        }
        inputEl.removeEventListener("input", onInput);
        inputEl.removeEventListener("paste", onPaste);
    };
}
