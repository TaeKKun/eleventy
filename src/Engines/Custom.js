const TemplateEngine = require("./TemplateEngine");
const getJavaScriptData = require("../Util/GetJavaScriptData");
const bench = require("../BenchmarkManager").get("Aggregate");

class CustomEngine extends TemplateEngine {
  constructor(name, dirs, config) {
    super(name, dirs, config);

    this.entry = this.getExtensionMapEntry();
    this.needsInit =
      "init" in this.entry && typeof this.entry.init === "function";

    this._defaultEngine = undefined;

    // Enable cacheability for this template
    if (this.entry.compileOptions && "cache" in this.entry.compileOptions) {
      this.cacheable = this.entry.compileOptions.cache;
    }
  }

  getExtensionMapEntry() {
    if ("extensionMap" in this.config) {
      for (let entry of this.config.extensionMap) {
        if (entry.key.toLowerCase() === this.name.toLowerCase()) {
          return entry;
        }
      }
    }

    throw Error(
      `Could not find a custom extension for ${this.name}. Did you add it to your config file?`
    );
  }

  setDefaultEngine(defaultEngine) {
    this._defaultEngine = defaultEngine;
  }

  needsToReadFileContents() {
    if ("read" in this.entry) {
      return this.entry.read;
    }
    return true;
  }

  // If we init from multiple places, wait for the first init to finish
  // before continuing on.
  async _runningInit() {
    if (this.needsInit) {
      let initBench = bench.get(`Engine (${this.name}) Init`);
      initBench.before();
      if (!this._initing) {
        this._initing = this.entry.init.bind({
          config: this.config,
          bench,
        })();
      }
      await this._initing;
      this.needsInit = false;
      initBench.after();
    }
  }

  async getExtraDataFromFile(inputPath) {
    await this._runningInit();

    if ("getData" in this.entry) {
      let dataBench = bench.get(`Engine (${this.name}) Get Data From File`);
      dataBench.before();

      if (typeof this.entry.getData === "function") {
        let data = this.entry.getData(inputPath);
        dataBench.after();
        return data;
      } else {
        if (!("getInstanceFromInputPath" in this.entry)) {
          dataBench.after();
          return Promise.reject(
            new Error(
              `getInstanceFromInputPath callback missing from ${this.name} template engine plugin.`
            )
          );
        }

        let keys = new Set();
        if (this.entry.getData === true) {
          keys.add("data");
        } else if (Array.isArray(this.entry.getData)) {
          for (let key of this.entry.getData) {
            keys.add(key);
          }
        }

        if (keys.size === 0) {
          dataBench.after();
          return Promise.reject(
            new Error(
              `getData must be an array of keys or \`true\` in your addExtension configuration.`
            )
          );
        }

        let inst = await this.entry.getInstanceFromInputPath(inputPath);
        let mixins;
        if (this.config) {
          // Object.assign usage: see TemplateRenderCustomTest.js: `JavaScript functions should not be mutable but not *that* mutable`
          mixins = Object.assign({}, this.config.javascriptFunctions);
        }

        // override keys set at the plugin level in the individual template
        if (inst.eleventyDataKey) {
          keys = new Set(inst.eleventyDataKey);
        }

        let promises = [];
        for (let key of keys) {
          promises.push(
            getJavaScriptData(inst, inputPath, key, {
              mixins,
              isObjectRequired: key === "data",
            })
          );
        }

        let results = await Promise.all(promises);
        let data = {};
        for (let result of results) {
          Object.assign(data, result);
        }
        dataBench.after();

        return data;
      }
    }
  }

  async compile(str, inputPath, ...args) {
    await this._runningInit();

    let defaultRenderer;
    if (this._defaultEngine) {
      defaultRenderer = async (data) => {
        const render = await this._defaultEngine.compile(
          str,
          inputPath,
          ...args
        );
        return render(data);
      };
    }

    // Fall back to default compiler if the user does not provide their own
    if (!this.entry.compile && defaultRenderer) {
      return defaultRenderer;
    }

    // TODO generalize this (look at JavaScript.js)
    let fn = this.entry.compile.bind({ config: this.config })(str, inputPath);
    if (typeof fn === "function") {
      // give the user access to this engine's default renderer, if any
      return fn.bind({ defaultRenderer });
    }
    return fn;
  }

  get defaultTemplateFileExtension() {
    return this.entry.outputFileExtension;
  }

  getCompileCacheKey(str, inputPath) {
    if (
      this.entry.compileOptions &&
      "getCacheKey" in this.entry.compileOptions
    ) {
      if (typeof this.entry.compileOptions.getCacheKey !== "function") {
        throw new Error(
          `\`compileOptions.getCacheKey\` must be a function in addExtension for the ${this.name} type`
        );
      }

      return this.entry.compileOptions.getCacheKey(str, inputPath);
    }
    return super.getCompileCacheKey(str, inputPath);
  }

  permalinkNeedsCompilation(str) {
    if (this.entry.compileOptions && "permalink" in this.entry.compileOptions) {
      let p = this.entry.compileOptions.permalink;
      if (p === false || p === "raw") {
        return false;
      }
      return this.entry.compileOptions.permalink;
    }

    return true;
  }
}

module.exports = CustomEngine;
