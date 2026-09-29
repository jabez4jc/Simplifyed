/**
 * The input a name stands for, which is not the input it was given.
 *
 * `len = input(14, "Length")` makes the name a second spelling of the setting:
 * it is the input's own slot, it folds to the input's key where a declaration
 * option wants a constant, and a read's expression resolves it to the setting
 * (`compiled-program.md` 2.3, 2.6 and 2.16). `var len = input(14, "Length")`
 * declares a cell a later assignment may change (`language.md` 8.2), so it
 * holds the setting on the first bar and whatever it is given after that, and
 * not one of those three is true of it.
 *
 * `input` stays set on both, because the input is the row either spelling
 * declares and a row nothing reads is OS8018 either way. This is the narrower
 * question, asked in one place so that three passes cannot answer it twice.
 */
export function inputHeldBy(binding) {
    return binding.persistence === 'none' ? binding.input : undefined;
}
//# sourceMappingURL=checked.js.map