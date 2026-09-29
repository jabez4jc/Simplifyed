/**
 * Every statement form of language.md section 10, plus the block they nest in.
 *
 * There is no statement that is also an expression and no expression that is
 * also a statement: assignment is a statement (10.1), and `switch` is a
 * statement rather than a value (10.6). That is why `if x = 5` can be OS1006
 * with a fix naming `==` instead of a type error three stages later.
 */
export const ASSIGNMENT_OPERATORS = ['=', '+=', '-=', '*=', '/=', '%='];
//# sourceMappingURL=statements.js.map