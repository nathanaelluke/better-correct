import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";

const banner =
	"/* eslint-disable */\n" +
	"if (typeof global === 'undefined') { var global = globalThis; }\n";

const context = await esbuild.context({
	banner: {
		js: banner,
	},
	bundle: true,
	entryPoints: ["src/main.ts"],
	external: [
		"obsidian",
		"electron",
		...builtins,
	],
	format: "cjs",
	loader: {
		".aff": "text",
		".dic": "text",
	},
	logLevel: "info",
	outfile: "main.js",
	platform: "browser",
	sourcemap: "inline",
	target: "es2022",
	tsconfig: "tsconfig.json",
});

if (process.argv.includes("--watch")) {
	await context.watch();
} else {
	await context.rebuild();
	await context.dispose();
}
