// client.js

var sparql = function (endpoint, graph) {
  if (!endpoint) throw new Error("No endpoint provided!");

  this.endpoint = endpoint;
  this.graph = graph || "/";
};

// 直接使用XML来实现，fetch返回这个promise太麻烦了，真无语
sparql.prototype.query = function (options, cb) {

  if (typeof options === "string") {
    options = {
      graph: null,
      query: options,
    };
  }

  var graph = options.graph || this.graph;
  var query = "PREFIX dbo: <https://dbpedia.org/ontology/>" + options.query;

  if (!query) return cb(new Error("No query provided!"));
  if (!graph) return cb(new Error("No graph provided!"));

  var params = 'default-graph-uri=' + encodeURIComponent(graph) + '&' + 'query=' + encodeURIComponent(query) + '&' + 'format=' + encodeURIComponent('application/sparql-results+json') + '&' + 'timeout=30000';

  var othePram = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/sparql-results+json'
    },
    method: "GET"
  };

  console.log("query:", query);
  // try{
  //   let response = await fetch(this.endpoint + '?' + params, othePram);
  //   return await response.text(); // 返回text还是json来着？
  // }catch(error){
  //   console.log('Request Failed',error);
  // }

  var xhr = new XMLHttpRequest();

  // 发送
  xhr.open("get", this.endpoint + '?' + params, false)
  xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
  xhr.setRequestHeader("Accept", "application/sparql-results+json");
  xhr.send(null);

  // 监听
  if (xhr.readyState == 4 && xhr.status == 200) {
    var r = xhr.responseText;
    return r;
  }else{
    console.log("connect error!");
  }
};

// entitySparql.js
function getSparqlData2(entity) {
  const sparqlClient = new sparql("https://dbpedia.org/sparql/"); // 这里是https！
  const sparqlEntity = "http://dbpedia.org/resource/" + entity;
  // 数组保存nodes和relationships的id和其唯一标识符
  var NodesId = [];
  var RelsId = [];
  NodesId.push(sparqlEntity); //nodes中的id=NodesId+1

  // 获取该资源指向的其他资源和其他资源指向该资源的关系。
  var queryEntities = `select distinct ?p ?o where {<${sparqlEntity}> ?p ?o} `;
  var queryEntities2 = `select distinct ?p ?o where {?o ?p <${sparqlEntity}>} `;
  try {
    results = sparqlClient.query({
      graph: "http://dbpedia.org",
      query: queryEntities,
    });

    results2 = sparqlClient.query({
      graph: "http://dbpedia.org",
      query: queryEntities2,
    });

    console.log("results1", results); // undefined
    console.log("results2", results2);
    var neo4jData = {
      results: [
        {
          columns: ["user", "entity"],
          data: [
            {
              graph: {
                nodes: [],
                relationships: [],
              },
            },
          ],
        },
      ],
      errors: [],
    };

    // 将字符串转换为JavaScript对象 var jsondata = JSON.stringify(results);
    console.log("results:", results.toString());
    var jsonresult = JSON.parse(results);
    var predicate = jsonresult.head.vars[0];
    var object = jsonresult.head.vars[1];

    var jsonresult2 = JSON.parse(results2);
    var predicate2 = jsonresult2.head.vars[0];
    var object2 = jsonresult2.head.vars[1];

    // 先遍历jsonresult，构建查询实体与其属性（查询实体的node）
    var bindings = jsonresult.results.bindings;
    var bindings2 = jsonresult2.results.bindings;

    var RootNode = {};
    // NodesId.push();
    RootNode["id"] = "1"; // node id必须从1开始分配
    RootNode["labels"] = [entity];
    RootNode["properties"] = {};
    RootNode["properties"]["uri"] = sparqlEntity; // 手动添加uri资源标识符属性

    // 规定只放8个属性
    var propertyNum = 0;
    for (var i = 0; i < bindings.length; i++) {
      // 对于每一条binding，如果宾语的type正则匹配literal（literal和typed-literal），则将其添加到查询实体的属性中
      var objType = bindings[i][object].type;
      var objValue = bindings[i][object].value;
      //var predValue = bindings[i][predicate].value;
      // 指向属性的谓词标准化，使用正则表达式
      var finalPara = new RegExp("[^/]+(?!.*/)");
      var predValue = finalPara.exec(bindings[i][predicate].value);

      if (objType.match(/literal/)) {
        if (propertyNum < 8) {
          // 如果有"xml:lang"键(用于指定具有语言标签的文字)，则只取值为"xml:lang" : "en"的属性值(在有选择的情况下打印英文信息)
          if (RootNode["properties"][predValue]) {
            if (
              bindings[i][object]["xml:lang"] &&
              bindings[i][object]["xml:lang"] == "en"
            ) {
              RootNode["properties"][predValue] = objValue;
              propertyNum++;
            } else {
              continue;
            }
          } else {
            RootNode["properties"][predValue] = objValue;
            propertyNum++;
          }
        }
      }
    }
    // console.log(RootNode);
    neo4jData["results"][0]["data"][0]["graph"]["nodes"].push(RootNode);

    // 然后构建与查询实体相连接的实体及与其他实体之间的关系，注意实体的前缀是'https?://dbpedia.org/resource/'
    // debug-2021/5/12-djy for循环和continue
    var TempNodeObj = {};
    var TempRelsObj = {};
    var nodeNum = 0;
    var nodeNum2 = 0;

    // 向外指的节点
    for (var i = 0; i < bindings.length; i++) {
      // 规定只显示前10个相关联的实体
      if (nodeNum < 10) {
        // 对于每一条bindings，如果宾语的type正则匹配uri(存在疑问)，则该bindings表示查询实体与其他实体的联系
        var objType = bindings[i][object].type;
        var objValue = bindings[i][object].value;
        var finalPara = new RegExp("[^/]+(?!.*/)");
        var re = new RegExp("https?://dbpedia.org/resource/");
        var predValue = finalPara.exec(bindings[i][predicate].value);
        var res = re.exec(objValue);

        if (objType.match(/uri/) && res) {
          // 只标注该查询实体的uri为properties，双击后可以展开该实体的属性和与其他实体之间的关系。

          if (NodesId.indexOf(objValue) == -1) {
            nodeNum++;
            // 如果nodesid数组中没找到objValue，那么就新加一个，否则就不添加了
            NodesId.push(objValue);
            var TempNodeId = (NodesId.indexOf(objValue) + 1).toString();
            TempNodeObj["id"] = TempNodeId;
            TempNodeObj["labels"] = [objValue.replace(re, "")];
            TempNodeObj["properties"] = {};
            TempNodeObj["properties"]["uri"] = objValue;

            // uri:objValue，查询objValue的属性
            var queryEntities_1 = `select distinct ?p ?o where {<${objValue}> ?p ?o} `;
            results_1 = sparqlClient.query({
              graph: "http://dbpedia.org",
              query: queryEntities_1,
            });

            var jsonresult_1 = JSON.parse(results_1);
            var predicate_1 = jsonresult_1.head.vars[0];
            var object_1 = jsonresult_1.head.vars[1];
            var bindings_1 = jsonresult_1.results.bindings;
            var propertyNum_1 = 0;

            for (var j = 0; j < bindings_1.length; j++) {
              var objType_1 = bindings_1[j][object_1].type;
              var objValue_1 = bindings_1[j][object_1].value;
              var finalPara_1 = new RegExp("[^/]+(?!.*/)");
              var predValue_1 = finalPara_1.exec(
                bindings_1[j][predicate_1].value
              );

              if (objType_1.match(/literal/)) {
                if (propertyNum_1 < 8) {
                  // 如果有"xml:lang"键(用于指定具有语言标签的文字)，则只取值为"xml:lang" : "en"的属性值(在有选择的情况下打印英文信息)
                  if (TempNodeObj["properties"][predValue_1]) {
                    if (
                      bindings_1[j][object_1]["xml:lang"] &&
                      bindings_1[j][object_1]["xml:lang"] == "en"
                    ) {
                      TempNodeObj["properties"][predValue_1] = objValue_1;
                      propertyNum_1++;
                    } else {
                      continue;
                    }
                  } else {
                    TempNodeObj["properties"][predValue_1] = objValue_1;
                    propertyNum_1++;
                  }
                }
              }
            }
          } else {
            continue;
          }
          // 最后添加查询实体与相连实体之间的关系，这里查找下标只是为了确定关系的id
          // debug：endNode有错，对于相同关系的uri，endoNode都是一样的
          if (RelsId.indexOf(predValue) == -1) {
            RelsId.push(predValue);
          }
          var TempRelsID = (RelsId.indexOf(predValue) + 1).toString();
          TempRelsObj["id"] = TempRelsID;
          TempRelsObj["type"] = predValue;
          // TempRelsObj["startNode"] = (RelsId.indexOf(sparqlEntity)+1).toString();
          // 第一次查询具有单向性
          TempRelsObj["startNode"] = "1";
          TempRelsObj["endNode"] = (NodesId.indexOf(objValue) + 1).toString();

          neo4jData["results"][0]["data"][0]["graph"]["nodes"].push(
            TempNodeObj
          );
          neo4jData["results"][0]["data"][0]["graph"]["relationships"].push(
            TempRelsObj
          );
        }
        TempNodeObj = {};
        TempRelsObj = {};
      }
    }
    // console.log(typeof(neo4jData));

    // 向内指的节点
    for (var i = 0; i < bindings2.length; i++) {
      if (nodeNum2 < 10) {
        // 对于每一条bindings，如果宾语的type正则匹配uri(存在疑问)，则该bindings表示查询实体与其他实体的联系
        var objType = bindings2[i][object2].type;
        var objValue = bindings2[i][object2].value;
        var finalPara = new RegExp("[^/]+(?!.*/)");
        var re = new RegExp("https?://dbpedia.org/resource/");
        var predValue = finalPara.exec(bindings[i][predicate].value);
        var res = re.exec(objValue);

        if (objType.match(/uri/) && res) {
          // 只标注该查询实体的uri为properties，双击后可以展开该实体的属性和与其他实体之间的关系。
          if (NodesId.indexOf(objValue) == -1) {
            nodeNum2++;
            // 如果nodesid数组中没找到objValue，那么就新加一个，否则就不添加了
            NodesId.push(objValue);
            var TempNodeId = (NodesId.indexOf(objValue) + 1).toString();
            TempNodeObj["id"] = TempNodeId;
            TempNodeObj["labels"] = [objValue.replace(re, "")];
            TempNodeObj["properties"] = {};
            TempNodeObj["properties"]["uri"] = objValue;

            // uri:objValue，查询objValue的属性
            var queryEntities_1 = `select distinct ?p ?o where {<${objValue}> ?p ?o} `;
            results_1 = sparqlClient.query({
              graph: "http://dbpedia.org",
              query: queryEntities_1,
            });

            var jsonresult_1 = JSON.parse(results_1);
            var predicate_1 = jsonresult_1.head.vars[0];
            var object_1 = jsonresult_1.head.vars[1];
            var bindings_1 = jsonresult_1.results.bindings;
            var propertyNum_1 = 0;

            for (var j = 0; j < bindings_1.length; j++) {
              var objType_1 = bindings_1[j][object_1].type;
              var objValue_1 = bindings_1[j][object_1].value;
              var finalPara_1 = new RegExp("[^/]+(?!.*/)");
              var predValue_1 = finalPara_1.exec(
                bindings_1[j][predicate_1].value
              );

              if (objType_1.match(/literal/)) {
                if (propertyNum_1 < 8) {
                  // 如果有"xml:lang"键(用于指定具有语言标签的文字)，则只取值为"xml:lang" : "en"的属性值(在有选择的情况下打印英文信息)
                  if (TempNodeObj["properties"][predValue_1]) {
                    if (
                      bindings_1[j][object_1]["xml:lang"] &&
                      bindings_1[j][object_1]["xml:lang"] == "en"
                    ) {
                      TempNodeObj["properties"][predValue_1] = objValue_1;
                      propertyNum_1++;
                    } else {
                      continue;
                    }
                  } else {
                    TempNodeObj["properties"][predValue_1] = objValue_1;
                    propertyNum_1++;
                  }
                }
              }
            }
          } else {
            continue;
          }
          // 最后添加查询实体与相连实体之间的关系，这里查找下标只是为了确定关系的id
          // debug：endNode有错，对于相同关系的uri，endoNode都是一样的
          if (RelsId.indexOf(predValue) == -1) {
            RelsId.push(predValue);
          }
          var TempRelsID = (RelsId.indexOf(predValue) + 1).toString();
          TempRelsObj["id"] = TempRelsID;
          TempRelsObj["type"] = predValue;
          // TempRelsObj["startNode"] = (RelsId.indexOf(sparqlEntity)+1).toString();
          // 第二次反向查询
          TempRelsObj["startNode"] = (NodesId.indexOf(objValue) + 1).toString();
          TempRelsObj["endNode"] = "1";

          neo4jData["results"][0]["data"][0]["graph"]["nodes"].push(
            TempNodeObj
          );
          neo4jData["results"][0]["data"][0]["graph"]["relationships"].push(
            TempRelsObj
          );
        }
        TempNodeObj = {};
        TempRelsObj = {};
      }
    }
  } catch (err) {
    console.log(err);
    console.log(queryEntities);
    results = [];
  }
  return neo4jData;
}

// 可视化函数
function init() {
  // console.log("in the init function!!");
  try {
    //   const entity = Router.current().params._entity;
    const entity = "Dainik_Jagran";
    var n4jdata = getSparqlData2(entity);
    // console.log(n4jdata);
  } catch (err) {
    var n4jdata = {};
    // console.log(err);
  }

  //   n4jdata = {
  //     "results": [
  //         {
  //             "columns": ["user", "entity"],
  //             "data": [
  //                 {
  //                     "graph": {
  //                         "nodes": [
  //                             {
  //                                 "id": "1",
  //                                 "labels": ["User"],
  //                                 "properties": {
  //                                     "userId": "eisman"
  //                                 }
  //                             },
  //                             {
  //                                 "id": "8",
  //                                 "labels": ["Project"],
  //                                 "properties": {
  //                                     "name": "neo4jd3",
  //                                     "title": "neo4jd3.js",
  //                                     "description": "Neo4j graph visualization using D3.js.",
  //                                     "url": "https://eisman.github.io/neo4jd3"
  //                                 }
  //                             }
  //                         ],
  //                         "relationships": [
  //                             {
  //                                 "id": "7",
  //                                 "type": "DEVELOPES",
  //                                 "startNode": "1",
  //                                 "endNode": "8",
  //                                 "properties": {
  //                                     "from": 1470002400000
  //                                 }
  //                             }
  //                         ]
  //                     }
  //                 }
  //             ]
  //         }
  //     ],
  //     "errors": []
  // }
  // // getSparqlData2("Dainik_Jagran");
  // console.log(n4jdata);

  // 获取当前url的名称
  // const entity = Router.current().params._entity;

  // 将数据可视化
  var neo4jd3 = new Neo4jd3("#neo4jd3", {
    // highlight: [
    //     {
    //         class: 'Project',
    //         property: 'name',
    //         value: 'neo4jd3'
    //     }, {
    //         class: 'User',
    //         property: 'userId',
    //         value: 'eisman'
    //     }
    // ],
    icons: {
      Label: "label",
    },
    //                     icons: {
    // //                        'Address': 'home',
    //                         'Api': 'gear',
    // //                        'BirthDate': 'birthday-cake',
    //                         'Cookie': 'paw',
    // //                        'CreditCard': 'credit-card',
    // //                        'Device': 'laptop',
    //                         'Email': 'at',
    //                         'Git': 'git',
    //                         'Github': 'github',
    //                         'Google': 'google',
    // //                        'icons': 'font-awesome',
    //                         'Ip': 'map-marker',
    //                         'Issues': 'exclamation-circle',
    //                         'Language': 'language',
    //                         'Options': 'sliders',
    //                         'Password': 'lock',
    //                         'Phone': 'phone',
    //                         'Project': 'folder-open',
    //                         'SecurityChallengeAnswer': 'commenting',
    //                         'User': 'user',
    //                         'zoomFit': 'arrows-alt',
    //                         'zoomIn': 'search-plus',
    //                         'zoomOut': 'search-minus'
    //                     },
    //                     images: {
    //                         'Address': '/static/neo4jd3/docs/img/twemoji/1f3e0.svg',
    // //                        'Api': 'img/twemoji/1f527.svg',
    //                         'BirthDate': '/static/neo4jd3/docs/img/twemoji/1f382.svg',
    //                         'Cookie': '/static/neo4jd3/docs/img/twemoji/1f36a.svg',
    //                         'CreditCard': '/static/neo4jd3/docs/img/twemoji/1f4b3.svg',
    //                         'Device': '/static/neo4jd3/docs/img/twemoji/1f4bb.svg',
    //                         'Email': '/static/neo4jd3/docs/img/twemoji/2709.svg',
    //                         'Git': '/static/neo4jd3/docs/img/twemoji/1f5c3.svg',
    //                         'Github': '/static/neo4jd3/docs/img/twemoji/1f5c4.svg',
    //                         'icons': '/static/neo4jd3/docs/img/twemoji/1f38f.svg',
    //                         'Ip': '/static/neo4jd3/docs/img/twemoji/1f4cd.svg',
    //                         'Issues': '/static/neo4jd3/docs/img/twemoji/1f4a9.svg',
    //                         'Language': '/static/neo4jd3/docs/img/twemoji/1f1f1-1f1f7.svg',
    //                         'Options': '/static/neo4jd3/docs/img/twemoji/2699.svg',
    //                         'Password': '/static/neo4jd3/docs/img/twemoji/1f511.svg',
    // //                        'Phone': 'img/twemoji/1f4de.svg',
    //                         'Project': '/static/neo4jd3/docs/img/twemoji/2198.svg',
    //                         'Project|name|neo4jd3': '/static/neo4jd3/docs/img/twemoji/2196.svg',
    // //                        'SecurityChallengeAnswer': 'img/twemoji/1f4ac.svg',
    //                         'User': '/static/neo4jd3/docs/img/twemoji/1f600.svg'
    // //                        'zoomFit': 'img/twemoji/2194.svg',
    // //                        'zoomIn': 'img/twemoji/1f50d.svg',
    // //                        'zoomOut': 'img/twemoji/1f50e.svg'
    //                     },
    minCollision: 100,
    neo4jData: n4jdata,
    // neo4jDataUrl: '/static/neo4jd3/docs/json/neo4jData2.json',
    nodeRadius: 25,
    // 可能要重写onNodeDoubleClick函数了，因为源代码是random生成的。
    // onNodeDoubleClick: function(node) {
    //     switch(node.id) {
    //         case '25':
    //             // Google
    //             window.open(node.properties.url, '_blank');
    //             break;
    //         default:
    //             var maxNodes = 5,
    //                 data = neo4jd3.randomD3Data(node, maxNodes);
    //             neo4jd3.updateWithD3Data(data);
    //             break;
    //     }
    // },
    // onRelationshipDoubleClick: function(relationship) {
    //     console.log('double click on relationship: ' + JSON.stringify(relationship));
    // },
    zoomFit: true,
  });
}
window.onload = init;
