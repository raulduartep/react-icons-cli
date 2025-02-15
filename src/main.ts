#!/usr/bin/env node

import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import ora from "ora";
import inquirer from "inquirer";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigPlugin, transform } from "@svgr/core";
import findUp from "find-up";
import { program } from "commander";

const execAsync = promisify(exec);

const ROOT_DIR = path.resolve(__dirname, "..");
const TEMP_DIR = path.join(ROOT_DIR, "temp");
const UNPACKED_REACT_ICONS_PATH = path.join(TEMP_DIR, "react-icons");

type TIconTree = {
  tag: string;
  attr: { [key: string]: string };
  child: TIconTree[];
};

type TConfig = {
  native: boolean;
  typescript: boolean;
  dir: string;
  cached: boolean;

  // Auto populated
  rootPath: string;
};

async function getConfigs(): Promise<TConfig> {
  const spinner = ora("Getting configs").start();
  const configPath = await findUp("react-icons.config.json");
  if (!configPath) {
    console.error("Error: Cannot find the react-icons.config.json file");
    process.exit(1);
  }

  const file = await fs.promises.readFile(configPath, "utf-8");
  const parsedFile = JSON.parse(file);

  if (!parsedFile.dir) {
    spinner.fail(
      "Error: dir field is required in react-icons.config.json file"
    );
    process.exit(1);
  }

  if (typeof parsedFile.dir !== "string") {
    spinner.fail(
      "Error: dir field must be a string in react-icons.config.json file"
    );
    process.exit(1);
  }

  if (parsedFile.native && typeof parsedFile.native !== "boolean") {
    spinner.fail(
      "Error: native field must be a boolean in react-icons.config.json file"
    );
    process.exit(1);
  }

  if (parsedFile.typescript && typeof parsedFile.typescript !== "boolean") {
    spinner.fail(
      "Error: typescript field must be a boolean in react-icons.config.json file"
    );
    process.exit(1);
  }

  if (parsedFile.cached && typeof parsedFile.cached !== "boolean") {
    spinner.fail(
      "Error: cached field must be a boolean in react-icons.config.json file"
    );
    process.exit(1);
  }

  spinner.succeed("Got configs");

  return {
    dir: parsedFile.dir,
    native: parsedFile.native ?? false,
    typescript: parsedFile.typescript ?? false,
    cached: parsedFile.cached ?? false,
    rootPath: path.dirname(configPath),
  };
}

async function downloadReactIconsPackage() {
  const downloadSpinner = ora("Downloading react-icons package").start();

  let rootFiles = await fs.promises.readdir(ROOT_DIR);

  if (!rootFiles.includes("react-icons")) {
    await execAsync(`npm pack react-icons --pack-destination="${ROOT_DIR}"`);
    rootFiles = await fs.promises.readdir(ROOT_DIR);
  }

  const reactIconsFileName = rootFiles.find((file) =>
    file.includes("react-icons")
  );
  if (!reactIconsFileName) {
    console.error("Error: Cannot find react-icons package");
    process.exit(1);
  }

  downloadSpinner.succeed("Downloaded react-icons package");

  const unpackSpinner = ora("Unpacking react-icons package").start();

  const packedReactIconsPath = path.join(ROOT_DIR, reactIconsFileName);

  await fs.promises.mkdir(UNPACKED_REACT_ICONS_PATH, { recursive: true });
  await tar.x({ file: packedReactIconsPath, cwd: UNPACKED_REACT_ICONS_PATH });

  unpackSpinner.succeed("Unpacked react-icons package");
  return {
    reactIconsFileName,
  };
}

async function getIconProjects(): Promise<{ id: string; name: string }[]> {
  const spinner = ora("Extracting projects from react-icons package").start();

  const iconsManifestPath = path.join(
    UNPACKED_REACT_ICONS_PATH,
    "package",
    "lib",
    "iconsManifest.js"
  );

  const iconsManifest = await fs.promises.readFile(iconsManifestPath, "utf-8");
  const iconManifestJsonString = iconsManifest.replace(
    "module.exports.IconsManifest = ",
    ""
  );
  const iconsManifestJson = JSON.parse(iconManifestJsonString);

  const projects = iconsManifestJson.map((manifest: any) => ({
    id: manifest.id,
    name: manifest.name,
  }));

  spinner.succeed("Extracted projects from react-icons package");
  return projects;
}

async function getProjectIconsFileDefinition(projectId: string) {
  const spinner = ora("Extracting icons from react-icons package").start();

  const iconsPath = path.join(
    UNPACKED_REACT_ICONS_PATH,
    "package",
    projectId,
    "index.d.ts"
  );
  const code = await fs.promises.readFile(iconsPath, "utf-8");

  spinner.succeed("Extracted icons from react-icons package");

  return code;
}

function tree2Element(tree: TIconTree[]): React.ReactElement[] {
  return (
    tree &&
    tree.map((node, i) =>
      createElement(
        node.tag,
        { key: i, ...node.attr },
        tree2Element(node.child)
      )
    )
  );
}

const replaceSvgElementToSvgPlugin = (code: string) => code.replaceAll("SVGSVGElement", "Svg")

async function getIconSvg(
  projectId: string,
  iconName: string,
  config: TConfig
) {
  const extractSpinner = ora(
    "Extracting icons from react-icons package"
  ).start();

  const iconsPath = path.join(
    UNPACKED_REACT_ICONS_PATH,
    "package",
    projectId,
    "index.js"
  );
  const code = await fs.promises.readFile(iconsPath, "utf-8");

  const regex = new RegExp(
    `module\\.exports\\.${iconName}\\s*=\\s*function\\s*${iconName}\\s*\\(props\\)\\s*{\\s*return\\s*GenIcon\\((\\{.*?\\})\\)`,
    "s"
  );

  const match = code.match(regex);
  if (!match) {
    extractSpinner.fail(
      `Error: Cannot find icon ${iconName} in project ${projectId}`
    );
    process.exit(1);
  }

  extractSpinner.succeed("Extracted icons from react-icons package");

  const transformSpinner = ora("Transforming icon to React component").start();

  const svg = JSON.parse(match[1]) as TIconTree;
  const svgComponent = tree2Element([svg]);
  const svgHtml = renderToStaticMarkup(svgComponent);

  const plugins: ConfigPlugin[] = [
    "@svgr/plugin-svgo",
    "@svgr/plugin-jsx",
    "@svgr/plugin-prettier",
  ]

  if(config.native)
    plugins.push(replaceSvgElementToSvgPlugin)

  let jsCode = await transform(
    svgHtml,
    {
      plugins,
      native: config.native,
      typescript: config.typescript,
      icon: true,
      exportType: "named",
      ref: true,
      namedExport: iconName,
    },
    {
      componentName: iconName,
    }
  );

  await fs.promises.mkdir(path.join(config.rootPath, config.dir), {
    recursive: true,
  });

  await fs.promises.writeFile(
    path.join(
      config.rootPath,
      config.dir,
      config.typescript ? `${iconName}.tsx` : `${iconName}.jsx`
    ),
    jsCode
  );

  transformSpinner.succeed("Transformed icon to React component");
}

async function main() {
  const config = await getConfigs();

  const { reactIconsFileName } = await downloadReactIconsPackage();

  const projects = await getIconProjects();

  let shouldExecAgain = false;

  do {
    const selectedProject = await inquirer.prompt([
      {
        type: "select",
        name: "value",
        message: "Select an icon project:",
        loop: false,
        choices: projects.map((project) => ({
          value: project.id,
          name: project.name,
        })),
      },
    ]);

    const iconsFileDefinition = await getProjectIconsFileDefinition(
      selectedProject.value
    );

    const selectedIcon = await inquirer.prompt([
      {
        type: "search",
        message: "Search for an icon:",
        name: "value",
        source: async (filter) => {
          const regex = new RegExp(
            `export\\s+declare\\s+const\\s+(\\w*${filter ?? ""}\\w*):\\s*IconType;`,
            "gi"
          );

          return [...iconsFileDefinition.matchAll(regex)].map(
            (match) => match[1]
          );
        },
      },
    ]);

    await getIconSvg(selectedProject.value, selectedIcon.value, config);

    const selectedShouldExecAgain = await inquirer.prompt([
      {
        type: "confirm",
        name: "value",
        message: "Do you want to select another icon project?",
      },
    ]);
    shouldExecAgain = selectedShouldExecAgain.value;
  } while (shouldExecAgain);

  await fs.promises.rm(TEMP_DIR, { recursive: true });
  if (!config.cached) {
    await fs.promises.rm(reactIconsFileName, { recursive: true });
  }
}

program.action(main).parse(process.argv);
