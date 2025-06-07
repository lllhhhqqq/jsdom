"use strict";
const lightningcss = require("lightningcss-wasm");
const cssom = require("rrweb-cssom"); // TODO: remove this once lightningcss is fully integrated
const whatwgEncoding = require("whatwg-encoding");
const whatwgURL = require("whatwg-url");
const { invalidateStyleCache } = require("./style-rules");

// TODO: this should really implement https://html.spec.whatwg.org/multipage/links.html#link-type-stylesheet
// It (and the things it calls) is nowhere close right now.
exports.fetchStylesheet = (elementImpl, urlString) => {
  const document = elementImpl._ownerDocument;
  let defaultEncoding = document._encoding;
  const resourceLoader = document._resourceLoader;

  if (elementImpl.localName === "link" && elementImpl.hasAttributeNS(null, "charset")) {
    defaultEncoding = whatwgEncoding.labelToName(elementImpl.getAttributeNS(null, "charset"));
  }

  function onStylesheetLoad(data) {
    // if the element was detached before the load could finish, don't process the data
    if (!elementImpl._attached) {
      return;
    }

    const css = whatwgEncoding.decode(data, defaultEncoding);

    // TODO: MIME type checking?
    if (elementImpl.sheet) {
      exports.removeStylesheet(elementImpl.sheet, elementImpl);
    }
    exports.createStylesheet(css, elementImpl, urlString);
  }

  resourceLoader.fetch(urlString, {
    element: elementImpl,
    onLoad: onStylesheetLoad
  });
};

// https://drafts.csswg.org/cssom/#remove-a-css-style-sheet
exports.removeStylesheet = (sheet, elementImpl) => {
  const { styleSheets } = elementImpl._ownerDocument;
  styleSheets._remove(sheet);

  // Remove the association explicitly; in the spec it's implicit so this step doesn't exist.
  elementImpl.sheet = null;

  invalidateStyleCache(elementImpl);

  // TODO: "Set the CSS style sheet’s parent CSS style sheet, owner node and owner CSS rule to null."
  // Probably when we have a real CSSOM implementation.
};

// https://drafts.csswg.org/cssom/#create-a-css-style-sheet kinda:
// - Parsing failures are not handled gracefully like they should be
// - The import rules stuff seems out of place, and probably should affect the load event...
exports.createStylesheet = (sheetText, elementImpl, baseURLString) => {
  let sheet;
  try {
    // TODO: figure out how to handle filename and other options
    const { code: processedCSSBuffer } = lightningcss.transform({
      filename: baseURLString || "style.css", // Use baseURLString if available
      code: Buffer.from(sheetText),
      minify: false,
      sourceMap: false,
      cssModules: false, // Assuming not using CSS Modules by default
      drafts: {
        nesting: true, // Enable CSS nesting
        customMedia: true // Enable custom media queries
      },
      // It's important to set errorRecovery to true to handle potential
      // syntax errors in a way that aligns with browser behavior.
      errorRecovery: true
    });

    // TODO: The following is a placeholder.
    // We need to properly convert the output of lightningcss (a StyleSheet object)
    // into the format expected by jsdom (likely a CSSOM StyleSheet object).
    // This might involve manually creating CSSRule objects and a StyleSheet.
    // For now, we'll re-parse with cssom to maintain current functionality,
    // but this is inefficient and needs to be replaced.
    const processedCSSText = processedCSSBuffer.toString();
    sheet = cssom.parse(processedCSSText);

    // Example of what might be needed (conceptual):
    // sheet = new CSSOM.CSSStyleSheet();
    // const parsedSheet = lightningcss.parse(processedCSSText, { filename: baseURLString || "style.css", nesting: true });
    // for (const rule of parsedSheet.rules) {
    //   // Convert Lightning CSS rule to CSSOM rule and add to sheet.cssRules
    //   // This will be complex and require mapping between the two structures.
    // }

  } catch (cause) {
    if (elementImpl._ownerDocument._defaultView) {
      const error = new Error("Could not parse CSS stylesheet with LightningCSS", { cause });
      error.sheetText = sheetText;
      error.type = "css-parsing";

      elementImpl._ownerDocument._defaultView._virtualConsole.emit("jsdomError", error);
    }
    return;
  }

  scanForImportRules(elementImpl, sheet.cssRules, baseURLString);

  addStylesheet(sheet, elementImpl);
};

// https://drafts.csswg.org/cssom/#add-a-css-style-sheet
function addStylesheet(sheet, elementImpl) {
  elementImpl._ownerDocument.styleSheets._add(sheet);

  // Set the association explicitly; in the spec it's implicit.
  elementImpl.sheet = sheet;

  invalidateStyleCache(elementImpl);

  // TODO: title and disabled stuff
}

// TODO this is actually really messed up and overwrites the sheet on elementImpl
// Tracking in https://github.com/jsdom/jsdom/issues/2124
function scanForImportRules(elementImpl, cssRules, baseURLString) {
  if (!cssRules) {
    return;
  }

  for (let i = 0; i < cssRules.length; ++i) {
    if (cssRules[i].cssRules) {
      // @media rule: keep searching inside it.
      scanForImportRules(elementImpl, cssRules[i].cssRules, baseURLString);
    } else if (cssRules[i].href) {
      // @import rule: fetch the resource and evaluate it.
      // See http://dev.w3.org/csswg/cssom/#css-import-rule
      //     If loading of the style sheet fails its cssRules list is simply
      //     empty. I.e. an @import rule always has an associated style sheet.

      // Use whatwgURL.URL instead of whatwgURL.parseURL so that we get an error we can use as the cause if the URL
      // doesn't parse.
      let parsed;
      try {
        parsed = new whatwgURL.URL(cssRules[i].href, baseURLString);
      } catch (cause) {
        const window = elementImpl._ownerDocument._defaultView;
        if (window) {
          // Synthetic cause to ensure that all resource loading errors have causes.
          const error = new Error(
            `Could not parse CSS @import URL "${cssRules[i].href}" relative to base URL "${baseURLString}"`,
            { cause }
          );
          error.type = "resource-loading";
          error.url = cssRules[i].href;
          window._virtualConsole.emit("jsdomError", error);
        }
      }

      if (parsed) {
        exports.fetchStylesheet(elementImpl, parsed.href);
      }
    }
  }
}
