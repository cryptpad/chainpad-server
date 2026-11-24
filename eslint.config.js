// SPDX-FileCopyrightText: 2026 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const globals = require("globals");

module.exports = [{
    ignores: ["**/node_modules/"],
}, {
    languageOptions: {
        globals: {
            ...globals.browser,
            ...globals.node,
            define: "readonly",
        },
        ecmaVersion: "latest",
        sourceType: "commonjs",
    },

    rules: {
        indent: ["off", 4],
        "linebreak-style": ["off", "unix"],
        quotes: ["off", "single"],
        semi: ["error", "always"],
        "no-irregular-whitespace": ["off"],
        "no-self-assign": ["off"],
        "no-empty": ["off"],
        "no-useless-escape": ["off"],
        "no-extra-boolean-cast": ["off"],
        "no-prototype-builtins": ["off"],
    },
}];
