// asl-validator ships no type declarations (CommonJS `module.exports = function validator(definition, opts)`).
declare module 'asl-validator' {
  interface AslValidationResult {
    isValid: boolean;
    errors: unknown[];
    errorsText(separator?: string): string;
  }
  function validator(definition: object, opts?: { checkPaths?: boolean; checkArn?: boolean }): AslValidationResult;
  export = validator;
}
