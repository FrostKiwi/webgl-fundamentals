
module.exports = function () { // wrapper in case we're in module_context mode

"use strict";

const args       = require('minimist')(process.argv.slice(2));
const cache      = new (require('inmemfilecache'));
const Feed       = require('feed');
const fs         = require('fs');
const glob       = require('glob');
const Handlebars = require('handlebars');
const hanson     = require('hanson');
const marked     = require('marked');
const path       = require('path');
const Promise    = require('promise');
const sitemap    = require('sitemap');
const utils      = require('./utils');
const moment     = require('moment');

//process.title = "build";

var executeP = Promise.denodeify(utils.execute);

marked.setOptions({
  rawHtml: true,
  //pedantic: true,
});

function applyObject(src, dst) {
  Object.keys(src).forEach(function(key) {
    dst[key] = src[key];
  });
  return dst;
}

function mergeObjects() {
  var merged = {};
  Array.prototype.slice.call(arguments).forEach(function(src) {
    applyObject(src, merged);
  });
  return merged;
}

function readFile(fileName) {
  return cache.readFileSync(fileName, "utf-8");
}

function writeFileIfChanged(fileName, content) {
  if (fs.existsSync(fileName)) {
    var old = readFile(fileName);
    if (content == old) {
      return;
    }
  }
  fs.writeFileSync(fileName, content);
  console.log("Wrote: " + fileName);
};

function copyFile(src, dst) {
  writeFileIfChanged(dst, readFile(src));
}

function replaceParams(str, params) {
  var template = Handlebars.compile(str);
  if (Array.isArray(params)) {
    params = mergeObjects.apply(null, params.slice().reverse());
  }

  return template(params);
}

function TemplateManager() {
  var templates = {};

  this.apply = function(filename, params) {
    var template = templates[filename];
    if (!template) {
      var template = Handlebars.compile(readFile(filename));
      templates[filename] = template;
    }

    if (Array.isArray(params)) {
      params = mergeObjects.apply(null, params.slice().reverse());
    }

    return template(params);
  };
}

var templateManager = new TemplateManager();

Handlebars.registerHelper('include', function(filename, options) {
  var context;
  if (options && options.hash && options.hash.filename) {
    var varName = options.hash.filename;
    filename = options.data.root[varName];
    context = options.hash;
  } else {
    context = options.data.root;
  }
  return templateManager.apply(filename, context);
});

Handlebars.registerHelper('example', function(options) {
  options.hash.width   = options.hash.width  ? "width:  " + options.hash.width  + "px;" : "";
  options.hash.height  = options.hash.height ? "height: " + options.hash.height + "px;" : "";
  options.hash.caption = options.hash.caption || options.data.root.defaultExampleCaption;
  options.hash.examplePath = options.data.root.examplePath;
  return templateManager.apply("build/templates/example.template", options.hash);
});

Handlebars.registerHelper('diagram', function(options) {

  options.hash.width  = options.hash.width || "400";
  options.hash.height = options.hash.height || "300";
  options.hash.examplePath = options.data.root.examplePath;
  options.hash.className = options.hash.className || "";

  return templateManager.apply("build/templates/diagram.template", options.hash);
});

Handlebars.registerHelper('image', function(options) {

  options.hash.examplePath = options.data.root.examplePath;
  options.hash.className = options.hash.className || "";
  options.hash.caption = options.hash.caption || "";

  if (options.hash.url.substring(0, 4) === 'http') {
    options.hash.examplePath = "";
  }

  return templateManager.apply("build/templates/image.template", options.hash);
});

var Builder = function(outBaseDir) {

  var g_articlesByLang = {};
  var g_articles = [];
  var g_langInfo;
  var g_langs;
  var g_langDB = {};
  var g_outBaseDir = outBaseDir;

  var extractHeader = (function() {
    var headerRE = /([A-Z0-9_-]+): (.*?)$/i;

    return function(content) {
      var metaData = { };
      var lines = content.split("\n");
      while (true) {
        var line = lines[0].trim();
        var m = headerRE.exec(line);
        if (!m) {
          break;
        }
        metaData[m[1].toLowerCase()] = m[2];
        lines.shift();
      }
      return {
        content: lines.join("\n"),
        headers: metaData,
      };
    };
  }());

  var loadMD = function(contentFileName) {
    var content = cache.readFileSync(contentFileName, "utf-8");
    return extractHeader(content);
  };

  function extractHandlebars(content) {
    var tripleRE = /\{\{\{.*?\}\}\}/g;
    var doubleRE = /\{\{\{.*?\}\}\}/g;

    var numExtractions = 0;
    var extractions = {
    };

    function saveHandlebar(match) {
      var id = "==HANDLEBARS_ID_" + (++numExtractions) + "==";
      extractions[id] = match;
      return id;
    }

    content = content.replace(tripleRE, saveHandlebar);
    content = content.replace(doubleRE, saveHandlebar);

    return {
      content: content,
      extractions: extractions,
    };
  }

  function insertHandlebars(info, content) {
    var handlebarRE = /==HANDLEBARS_ID_\d+==/g;

    function restoreHandlebar(match) {
      var value = info.extractions[match];
      if (value === undefined) {
        throw new Error("no match restoring handlebar for: " + match);
      }
      return value;
    }

    content = content.replace(handlebarRE, restoreHandlebar);

    return content;
  }

  var applyTemplateToFile = function(templatePath, contentFileName, outFileName, opt_extra) {
    console.log("processing: ", contentFileName);
    opt_extra = opt_extra || {};
    var data = loadMD(contentFileName);
    // Call prep's Content which parses the HTML. This helps us find missing tags
    // should probably call something else.
    //Convert(md_content)
    var metaData = data.headers;
    var content = data.content;
    //console.log(JSON.stringify(metaData, undefined, "  "));
    var info = extractHandlebars(content);
    var html = marked(info.content);
    html = insertHandlebars(info, html);
    html = replaceParams(html, [opt_extra, g_langInfo]);
    const relativeOutName = outFileName.replace(/\\/g, '/').substring(g_outBaseDir.length);
    metaData['content'] = html;
    metaData['langs'] = g_langs;
    metaData['src_file_name'] = contentFileName.replace(/\\/g, '/');
    metaData['dst_file_name'] = relativeOutName;
    metaData['basedir'] = "";
    metaData['toc'] = opt_extra.toc;
    metaData['templateOptions'] = opt_extra.templateOptions;
    metaData['langInfo'] = g_langInfo;
    metaData['url'] = "http://webglfundamentals.org/" + relativeOutName;
    metaData['screenshot'] = "http://webglfundamentals.org/webgl/lessons/resources/webglfundamentals.jpg";
    var basename = path.basename(contentFileName, ".md");
    [".jpg", ".png"].forEach(function(ext) {
      var filename = path.join("webgl", "lessons", "screenshots", basename + ext);
      if (fs.existsSync(filename)) {
        metaData['screenshot'] = "http://webglfundamentals.org/webgl/lessons/screenshots/" + basename + ext;
      }
    });

    var output = templateManager.apply(templatePath, metaData);
    writeFileIfChanged(outFileName, output)
    g_articles.push(metaData);
  };

  var applyTemplateToFiles = function(templatePath, filesSpec, extra) {
    var files = glob.sync(filesSpec).sort();
    files.forEach(function(fileName) {
      var ext = path.extname(fileName);
      var baseName = fileName.substr(0, fileName.length - ext.length);
      var outFileName = path.join(outBaseDir, baseName + ".html");
      applyTemplateToFile(templatePath, fileName, outFileName, extra);
    });

  };

  var addArticleByLang = function(article, lang) {
    var filename = path.basename(article.dst_file_name);
    var articleInfo = g_articlesByLang[filename];
    var url = "http://webglfundamentals.org" + article.dst_file_name;
    if (!articleInfo) {
      articleInfo = {
        url: url,
        changefreq: 'monthly',
        links: [],
      };
      g_articlesByLang[filename] = articleInfo;
    }
    articleInfo.links.push({
      url: url,
      lang: lang,
    });
  };

  var getLanguageSelection = function(lang) {
    var lessons = lang.lessons || ("webgl/lessons/" + lang.lang);
    var langInfo = hanson.parse(fs.readFileSync(path.join(lessons, "langinfo.hanson"), {encoding: "utf8"}));
    g_langDB[lang.lang] = {
      lang: lang.lang,
      language: langInfo.language,
    };
    return templateManager.apply("build/templates/lang-select.template", [lang, langInfo]);
  };

  this.preProcess = function(langs) {
     var langs = langs.map(getLanguageSelection).join("\n");
     g_langs = templateManager.apply("build/templates/languages.template", {languages: langs});
  };

  this.process = function(options) {
    console.log("Processing Lang: " + options.lang);
    options.lessons     = options.lessons     || ("webgl/lessons/" + options.lang);
    options.toc         = options.toc         || ("webgl/lessons/" + options.lang + "/toc.html");
    options.template    = options.template    || "build/templates/lesson.template";
    options.examplePath = options.examplePath === undefined ? "/webgl/lessons/" : options.examplePath;

    g_articles = [];
    g_langInfo = hanson.parse(fs.readFileSync(path.join(options.lessons, "langinfo.hanson"), {encoding: "utf8"}));

    applyTemplateToFiles(options.template, path.join(options.lessons, "webgl*.md"), options);

    function utcMomentFromGitLog(result) {
      const dateStr = result.stdout.split("\n")[0].trim();
      let utcDateStr = dateStr
        .replace(/"/g, "")   // WTF to these quotes come from!??!
        .replace(" ", "T")
        .replace(" ", "")
        .replace(/(\d\d)$/, ':$1');
      return moment.utc(utcDateStr);
    }

    const tasks = g_articles.map((article, ndx) => {
      return function() {
        return executeP('git', [
          'log',
          '--format="%ci"',
          '--name-only',
          '--diff-filter=A',
          article.src_file_name,
        ]).then((result) => {
          article.dateAdded = utcMomentFromGitLog(result);
        });
      };
    }).concat(g_articles.map((article, ndx) => {
       return function() {
         return executeP('git', [
           'log',
           '--format="%ci"',
           '--name-only',
           '--max-count=1',
           article.src_file_name,
         ]).then((result) => {
           article.dateModified = utcMomentFromGitLog(result);
    });
       };
    }));

    return tasks.reduce(function(cur, next){
        return cur.then(next);
    }, Promise.resolve()).then(function() {
      var articles = g_articles.filter(function(article) {
        return article.dateAdded != undefined;
      });
      articles = articles.sort(function(a, b) {
        return b.dateAdded - a.dateAdded;
      });

      var feed = new Feed({
        title:          g_langInfo.title,
        description:    g_langInfo.description,
        link:           g_langInfo.link,
        image:          'http://webglfundamentals.org/webgl/lessons/resources/webglfundamentals.jpg',
        date:           articles[0].dateModified.toDate(),
        published:      articles[0].dateModified.toDate(),
        updated:        articles[0].dateModified.toDate(),
        author: {
          name:       'WebGLFundamenals Contributors',
          link:       'http://webglfundamentals.org/contributors.html',
        },
      });

      articles.forEach(function(article, ndx) {
        feed.addItem({
          title:          article.title,
          link:           "http://webglfundamentals.org" + article.dst_file_name,
          description:    "",
          author: [
            {
              name:       'WebGLFundamenals Contributors',
              link:       'http://webglfundamentals.org/contributors.html',
            },
          ],
          // contributor: [
          // ],
          date:           article.dateModified.toDate(),
          published:      article.dateAdded.toDate(),
          // image:          posts[key].image
        });

        addArticleByLang(article, options.lang);
      });

      try {
        writeFileIfChanged(path.join(g_outBaseDir, options.lessons, "atom.xml"), feed.render('atom-1.0'));
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.resolve();
    }).then(function() {
      // this used to insert a table of contents
      // but it was useless being auto-generated
      applyTemplateToFile("build/templates/index.template", path.join(options.lessons, "index.md"), path.join(g_outBaseDir, options.lessons, "index.html"), {
        table_of_contents: "",
        templateOptions: g_langInfo,
      });
      return Promise.resolve();
    }, function(err) {
      console.error("ERROR!:");
      console.error(err);
      if (err.stack) {
        console.error(err.stack);
      }
    });
  }

  this.writeGlobalFiles = function() {
    var sm = sitemap.createSitemap ({
      hostname: 'http://webglfundamentals.org',
      cacheTime: 600000,
    });
    var articleLangs = { };
    Object.keys(g_articlesByLang).forEach(function(filename) {
      var article = g_articlesByLang[filename];
      var langs = {};
      article.links.forEach(function(link) {
        langs[link.lang] = true;
      });
      articleLangs[filename] = langs;
      sm.add(article);
    });
    var langInfo = {
      articles: articleLangs,
      langs: g_langDB,
    };
    var langJS = "window.langDB = " + JSON.stringify(langInfo, null, 2);
    writeFileIfChanged(path.join(g_outBaseDir, "langdb.js"), langJS);
    writeFileIfChanged(path.join(g_outBaseDir, "sitemap.xml"), sm.toString());
    copyFile(path.join(g_outBaseDir, "webgl/lessons/atom.xml"), path.join(g_outBaseDir, "atom.xml"));
    copyFile(path.join(g_outBaseDir, "webgl/lessons/index.html"), path.join(g_outBaseDir, "index.html"));

    applyTemplateToFile("build/templates/index.template", "contributors.md", path.join(g_outBaseDir, "contributors.html"), {
      table_of_contents: "",
      templateOptions: "",
    });
  };


};

var b = new Builder("out");

var readdirs = function(dirpath) {
  var dirsOnly = function(filename) {
    var stat = fs.statSync(filename);
    return stat.isDirectory();
  };

  var addPath = function(filename) {
    return path.join(dirpath, filename);
  };

  return fs.readdirSync("webgl/lessons")
      .map(addPath)
      .filter(dirsOnly);
};

var isLangFolder = function(dirname) {
  var filename = path.join(dirname, "langinfo.hanson");
  return fs.existsSync(filename);
};


var pathToLang = function(filename) {
  return {
    lang: path.basename(filename),
  };
};

var langs = [
  // English is special (sorry it's where I started)
  {
    template: "build/templates/lesson.template",
    lessons: "webgl/lessons",
    lang: 'en',
    toc: 'webgl/lessons/toc.html',
    examplePath: '/webgl/lessons/',
  },
];

langs = langs.concat(readdirs("webgl/lessons")
    .filter(isLangFolder)
    .map(pathToLang));

b.preProcess(langs);

var tasks = langs.map(function(lang) {
  return function() {
    return b.process(lang);
  };
});

return tasks.reduce(function(cur, next) {
  return cur.then(next);
}, Promise.resolve()).then(function() {
  b.writeGlobalFiles();
  cache.clear();
  return Promise.resolve();
});

};

