# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Project uses React and shadcn for on frontend. All shadcn components avaialbe in `components/ui` folder.

For backend it uses Next.js and primarly preferes server actions for communications between frontend and backend.

Ignore `.next` and `node_modules` folders.

Prefer using cmd tools like mv instead of rewriting files manually.

Never use `cd` because your working directory already is the root of the project.

Never && different commands.

# Coding Guidelines

Write minimalistic code until it’s requested explicitly:

* Don’t add duplicate code, make a modular function.
* Don’t add error and exceptions handling.
* Don’t read configs, relly on typescript types.
* Don’t make functions with more than 3 paramaters, prefer to use structures.
* Don’t fix unsused variables by hiding them, clean up or use them properly.
* Write typescript code simple and minimalistic like you would write it on python.
* Use installed pathlib.js for handling paths.
* Don’t fake any data or put useless placeholders which hides critical errors.

# Code conventions:

* Prefer to use single word names for local variables if possible.
* Don’t write single line if and for statements (body block should always go on new line).
* Always prefer using return early pattern.
* if you have 2 or more nested if statment prefer to make a separate function (you may need encapsule logic part in that function).
* Decompose big functions on smaller/modular ones, espectially with abstract logic.
* Prefer single quotes for string literals.
* Remove trailing spaces.
* Always keep ending new line.
* If format allows add ending comma for last elements in maps/arrays.
* Avoid using `any` as much as possible, everyhing should be typed.
* Avoid using generic object types with `{}`, always define proper interfaces or types.
* Always use `@/` notation for imports.
* Always add `{}` bracers for condition and loop bodies.
* Avoid expanding members as much as possible, prefer use `.` to access member.
* Do not left legacy code or legacy compatibility.

# React guidelines:

* If you need an abstract reusable element make a client component for that.
* Don’t use `useState` if it’s not necessary (doesn’t affect rendering, etc.).
* Don’t add loading/disabled/etc. states if it’s not requested explicitly.
* Prefer to make data variable for static data (such as navigation data).
* Prefer to use server actions over fetching requests.

# Component, styles and layout

* First of all use **shadcn** to make components
* To set up other styles project has tailwindcss.
* Don’t add extra styles (className) on routing pages - make components minimalistic, instead prefer to create components with all needed styles, extra divs, etc., they should be wrapped wrapped in separate files in modular way.

Order component paramerts like required:

* data fields first (title, name, text, description, etc.)
* flags and optinal options (isLoading, isEnabled, etc.)
* callbacks (onClick, onClose, etc.).

# Development workflow

* At the end of coding run autofix linting issues by `npm run lint -- --fix`.
* Check all remaining lint issues and fix them manually (try to fix everything including warnings and issues not related to the last changes).

# Plugin system

* Each plugin stored in subfolders in `plugins/`
* Each plugin should be registered in `plugins/index.ts`
* Plugins can register providers, components, routes, navigations menus, user menus, settings pages.

# Guidelines Updates

Ask to update this guidelines to memorize new patterns