// Root Expo entry.
//
// Under pnpm, `node_modules/expo` is a symlink into the pnpm store, so the
// default `node_modules/expo/AppEntry.js` (which does `require('../../App')`)
// resolves *inside the store*, not the project root, and Metro fails with:
//
//   Unable to resolve "../../App" from "node_modules/expo/AppEntry.js"
//
// Defining a project-local entry that calls `registerRootComponent` makes the
// root component resolution unambiguous regardless of how `node_modules/expo`
// is laid out.
import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
