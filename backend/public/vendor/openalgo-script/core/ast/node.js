/**
 * The three tables below are written as a record over the kinds of each group,
 * so a node kind added to a group without being added here does not compile.
 * A set built from an array would accept the omission and the guard would
 * quietly answer false for the new kind.
 */
const EXPRESSION_KINDS = {
    numberLiteral: true,
    stringLiteral: true,
    booleanLiteral: true,
    colorLiteral: true,
    noneLiteral: true,
    arrayLiteral: true,
    nameReference: true,
    grouping: true,
    unary: true,
    binary: true,
    ternary: true,
    call: true,
    index: true,
    member: true,
    missingExpression: true,
};
const STATEMENT_KINDS = {
    expressionStatement: true,
    assignment: true,
    varDeclaration: true,
    ifStatement: true,
    forRangeStatement: true,
    forInStatement: true,
    whileStatement: true,
    switchStatement: true,
    breakStatement: true,
    continueStatement: true,
    returnStatement: true,
    versionLine: true,
    scriptDeclaration: true,
    limitsLine: true,
};
const TYPE_ANNOTATION_KINDS = {
    namedType: true,
    seriesType: true,
    arrayType: true,
};
export function isExpression(node) {
    return Object.hasOwn(EXPRESSION_KINDS, node.kind);
}
export function isStatement(node) {
    return Object.hasOwn(STATEMENT_KINDS, node.kind);
}
export function isTypeAnnotation(node) {
    return Object.hasOwn(TYPE_ANNOTATION_KINDS, node.kind);
}
/**
 * The name a type annotation carries, for a diagnostic that has to quote it.
 *
 * OS2016 and OS2019 both put the annotation into their message, and the reader
 * expects to see what was written rather than the outermost word of it.
 */
export function typeAnnotationText(annotation) {
    switch (annotation.kind) {
        case 'namedType':
            return annotation.name;
        case 'seriesType':
            return `series ${typeAnnotationText(annotation.element)}`;
        case 'arrayType':
            return `array<${typeAnnotationText(annotation.element)}>`;
    }
}
//# sourceMappingURL=node.js.map