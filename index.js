/*
Copyright 2023 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

const parser = require("postcss-selector-parser");

/**
 * @typedef {object} Config
 * @property {string} namespace
 * @property {(selector: string, prop: string) => string} createPropertyName
 * @property {(identifierValue: string, identifierName: string) => string} createClassFromContainerQuery
 * @property {boolean} noFlatVariables
 * @property {boolean} noSelectors
 * @property {boolean} noFallbacks
 */

/**
 * This function validates the config input and provides fallback values as necessary;
 * if a config setting is provided as an invalid type, throws a warning and returns the fallback
 * @param {Config} opts - the config object from the postcss plugin
 * @returns {Config} - a cleaned config object
 */
function validateOptions(opts) {
  let ret = opts;
  if (
    opts &&
    typeof opts.namespace !== "string" &&
    typeof opts.namespace !== "undefined"
  ) {
    console.warn(
      "The namespace must be of type string. Using fallback value instead."
    );
    ret.namespace = undefined;
  }

  if (
    !opts ||
    !opts.createPropertyName ||
    typeof opts.createPropertyName !== "function"
  ) {
    if (
      opts.createPropertyName &&
      typeof opts.createPropertyName !== "function"
    ) {
      console.warn(
        "The createPropertyName input must be a function. Using fallback function instead."
      );
    }

    ret.createPropertyName = (selector, prop, containerQueryParameters) => {
      let namespace = "";
      if (selector.includes(":where("))
        selector = selector.replace(/^:where\((.*?)\)$/, "$1");

      const regex = /\(\s*--(.*?)\s*:\s*(.*?)\s*\)/;
      const match = containerQueryParameters.match(regex);
      /* Only processing the first match for now */
      const [, identifierName, identifierValue] = match;
      if (identifierName && identifierValue) {
        namespace += `${identifierName}-`;
      }

      const variableParts = [];
      if (namespace) variableParts.push(namespace);

      // This regex is designed to pull spectrum-ActionButton out of a selector
      const baseSelectorMatch = selector.match(
        /^\.([a-z]+-?(?:[\A-Z]\w+-{0,2})*)/
      );
      if (baseSelectorMatch) {
        const [, baseSelector] = baseSelectorMatch;
        prop = prop.replace(baseSelector, "", "g");
        variableParts.push(baseSelector);
        selector = selector.replace(baseSelector, "", "g");
      }

      const selectorParts = selector
        .replace(/\s+/g, "")
        .replace(/,/g, "")
        .split(".");
      const state = selectorParts.find((part) => part.startsWith("is-"));
      if (state) selectorParts.splice(selectorParts.indexOf(state), 1);

      variableParts.push(...selectorParts);
      variableParts.push(prop.replace(/^--/, ""));
      if (state) variableParts.push(state.replace(/^is-/, ""));

      return `--${variableParts.join("-")?.replace(/-+/g, "-").toLowerCase()}`;
    };
  }

  if (
    !opts ||
    !opts.createClassFromContainerQuery ||
    typeof opts.createClassFromContainerQuery !== "function"
  ) {
    if (
      opts.createClassFromContainerQuery &&
      typeof opts.createClassFromContainerQuery !== "function"
    ) {
      console.warn(
        "The createClassFromContainerQuery input must be a function. Using fallback function instead."
      );
    }
    ret.createClassFromContainerQuery = (containerQueryParameters) => {
      // This checks for the presence of a variable declaration in the container; capturing the name and value
      const regex = /\(\s*--(.*?)\s*:\s*(.*?)\s*\)/g;
      const matches = [...(containerQueryParameters.matchAll(regex) ?? [])];
      if (!matches.length) return;

      return matches.reduce((classNames, match) => {
        const [, identifierName, identifierValue] = match;

        // If there's no variable declaration, we don't need to do anything
        if (!identifierName || !identifierValue) return classNames;

        let prefix = "";
        if (opts.namespace && identifierValue !== opts.namespace) {
          prefix = `${opts.namespace}--`;
        }
        // Create a new class name from the container parameters to house the newly created properties
        return `${classNames}.${prefix}${identifierValue}`;
      }, "");
    };
  }

  if (
    !opts ||
    !opts.noFlatVariables ||
    typeof opts.noFlatVariables !== "boolean"
  ) {
    if (opts.noFlatVariables && typeof opts.noFlatVariables !== "boolean")
      console.warn(
        "The noFlatVariables input must be a boolean. Using fallback value instead."
      );
    ret.noFlatVariables = false;
  }

  if (!opts || !opts.noSelectors || typeof opts.noSelectors !== "boolean") {
    if (opts.noSelectors && typeof opts.noSelectors !== "boolean")
      console.warn(
        "The noSelectors input must be a boolean. Using fallback value instead."
      );
    ret.noSelectors = false;
  }

  return ret;
}

/**
 * This function is the main entry point for the postcss plugin
 * @param {Config} opts
 * @returns
 */
module.exports = (opts = {}) => {
  // This function validates input and provides fallback values as necessary
  opts = validateOptions(opts);

  return {
    postcssPlugin: "postcss-splitinator",
    prepare() {
      const selectorMap = new Map();
      return {
        /**
         * @todo Maybe use this parser when it's released: https://github.com/postcss/postcss-at-rule-parser
         */
        AtRule(container, { Rule }) {
          // Only processing container rules with parameters defined; leave everything else alone
          if (container.name !== "container" || !container.params) return;

          // Create a new class name from the container parameters to house the newly created properties
          const newClassName = opts.createClassFromContainerQuery(
            container.params
          );
          if (!newClassName) return;

          /** Create a new rule to attach the new properties to; store them for now, add at the end */
          const containerRule = new Rule({
            selector: newClassName,
            source: container.source,
          });

          /**
           * Iterating over the declarations inside this container to find custom properties
           * and process them into a new selector
           */
          container.walkRules((rule) => {
            rule.walkDecls((decl) => {
              // Only process variables
              if (!decl.prop.startsWith("--")) return;

              // Process rules that match multiple selectors separately to avoid weird var names and edge cases
              // note: this doesn't support :where() and is likely brittle!
              parser((selectors) => {
                const selector = selectors.toString();
                const variableName = opts.createPropertyName(
                  selector,
                  decl.prop,
                  container.params
                );

                // Check for fallbacks
                const originalValue = decl.value;
                const fallbackMatch = originalValue.match(
                  /var\(\s*(.*?)\s*,\s*var\(\s*(.*?)\s*\)\)/
                );

                const entries = [];
                if (selectorMap.has(selector)) {
                  entries.push(...selectorMap.get(selector));
                }

                let newValue;
                if (!fallbackMatch) {
                  newValue = `var(${variableName})`;
                } else {
                  const [, override, fallback] = fallbackMatch;
                  // The final declaration should have the override present
                  newValue = `var(${override}, var(${variableName}${
                    fallback ? `, var(${fallback})` : ""
                  }))`;
                }

                if (
                  !entries.some(
                    (e) => e.prop === decl.prop && e.value === newValue
                  )
                ) {
                  entries.push(
                    decl.clone({
                      prop: decl.prop,
                      value: newValue,
                      raws: {
                        ...decl.raws,
                        before: "\n  ",
                        semicolon: true,
                      },
                    })
                  );
                }

                selectorMap.set(selector, entries);

                // The system-level declaration should only have the fallback
                if (!opts.noFlatVariables) {
                  const newDecl = decl.clone({
                    prop: variableName,
                    value: originalValue,
                    raws: {
                      ...decl.raws,
                      before: "\n  ",
                      semicolon: true,
                    },
                  });
                  containerRule.append(newDecl);
                }
              }).processSync(decl.parent.selector);

              // Remove the original declaration
              decl.remove();
            });

            rule.remove();
          });

          container.parent.insertAfter(container, containerRule);

          // Remove the original container rule
          container.remove();
        },
        OnceExit(root, { Rule }) {
          [...selectorMap.keys()].forEach((selector) => {
            const newRule = new Rule({
              selector,
              source: root.source,
              raws: { before: "\n  ", semicolon: true },
            });
            [...selectorMap.get(selector)].forEach((decl) => {
              decl.raws.semicolon = true;
              newRule.append(decl);
            });
            root.append(newRule);
          });
        },
      };
    },
  };
};

module.exports.postcss = true;
