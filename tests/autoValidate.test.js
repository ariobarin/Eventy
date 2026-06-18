import test from "node:test";
import assert from "node:assert/strict";
import {
    attachApiKeyAutoValidation,
    createPasteAutoValidator,
} from "../src/ui/autoValidate.js";

function createImmediateTimers() {
    return {
        setTimeoutFn: (fn) => {
            fn();
            return 1;
        },
        clearTimeoutFn: () => {},
    };
}

function createInputStub(initialValue = "") {
    const listeners = new Map();
    return {
        value: initialValue,
        addEventListener(event, handler) {
            listeners.set(event, handler);
        },
        removeEventListener(event, handler) {
            if (listeners.get(event) === handler) {
                listeners.delete(event);
            }
        },
        emit(event, payload) {
            const handler = listeners.get(event);
            if (handler) {
                handler(payload);
            }
        },
    };
}

test("createPasteAutoValidator triggers validation on paste input", () => {
    const calls = [];
    const { setTimeoutFn, clearTimeoutFn } = createImmediateTimers();
    const handler = createPasteAutoValidator({
        triggerValidate: () => calls.push("validated"),
        debounceMs: 0,
        minLength: 1,
        setTimeoutFn,
        clearTimeoutFn,
    });

    const didTrigger = handler({ inputType: "insertFromPaste" }, "sk-or-123456");

    assert.equal(didTrigger, true);
    assert.equal(calls.length, 1);
});

test("createPasteAutoValidator ignores non-paste input", () => {
    const calls = [];
    const { setTimeoutFn, clearTimeoutFn } = createImmediateTimers();
    const handler = createPasteAutoValidator({
        triggerValidate: () => calls.push("validated"),
        debounceMs: 0,
        minLength: 1,
        setTimeoutFn,
        clearTimeoutFn,
    });

    const didTrigger = handler({ inputType: "insertText" }, "sk-or-123456");

    assert.equal(didTrigger, false);
    assert.equal(calls.length, 0);
});

test("attachApiKeyAutoValidation wires input and paste", () => {
    const calls = [];
    const { setTimeoutFn, clearTimeoutFn } = createImmediateTimers();
    const input = createInputStub();

    attachApiKeyAutoValidation({
        inputEl: input,
        triggerValidate: () => calls.push("validated"),
        debounceMs: 0,
        minLength: 1,
        setTimeoutFn,
        clearTimeoutFn,
    });

    input.value = "sk-or-abc";
    input.emit("input", { inputType: "insertFromPaste" });

    input.value = "sk-or-def";
    input.emit("paste", { type: "paste" });

    assert.equal(calls.length, 2);
});
