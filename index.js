/**
 *   Neo4J Connector
 *
©2015 Luxembourg Institute of Science and Technology All Rights Reserved
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Authors : J.S. Sottet
*/

/* **************************************
TODO:
    - add logger
    - make a version with batch processing
    - read from DB
    - update nodes/model
*************************************** */
'use strict'

const neo4j = require('neo4j-driver').v1
    , _ = require('lodash')
    , jsmf = require('jsmf-core')
    , uuid = require('uuid')
    , r = require('./src/reify')

let driver

module.exports = function init(url, user, password) {
  if (user !== undefined && password !== undefined) {
    driver = neo4j.driver(url, neo4j.auth.basic(user, password),  {trust: 'TRUST_ON_FIRST_USE', encrypted: true})
  } else if (user === undefined && password === undefined) {
    driver = neo4j.driver(url)
  } else  {
    throw new Error('Invalid user/password pair')
  }
}

module.exports.close = () => driver.close()

module.exports.initStorage = () => {
  const existence = 'CREATE CONSTRAINT ON (a:JSMF) ASSERT exists(a.__jsmf__)'
  const uniqueness = 'CREATE CONSTRAINT ON (a:JSMF) ASSERT a.__jsmf__ IS UNIQUE'
  const session = driver.session()
  session.run([existence, uniqueness].join(' '))
}

module.exports.saveModel = function saveModel(m, ownTypes) {
  const reified = new Map()
  const rawElements = gatherElements(m)
  const elements = _.flatMap(rawElements, e => reifyMetaElement(e, reified, ownTypes))
  const session = driver.session()
  return saveElements(elements, reified, ownTypes, session)
    .then(m => saveRelationships(elements, m, reified, ownTypes, session))
    .then(() => session.close())
}

function gatherElements(m) {
  if (!(m instanceof jsmf.Model)) { return []}
  const result = m.elements()
  result.push(m)
  const mm = m.referenceModel
  return mm instanceof jsmf.Model
    ? result.concat(gatherElements(mm))
    : result
}

module.exports.loadModel = function loadModel(mm) {
  const session = driver.session()
  const classes = _.map(mm.classes, x => x[0])
  return Promise.all(_.map(classes, k => loadElements(k, session)))
    .then(elementsByClass =>
        _.flatMap(elementsByClass, elements => {
          const cls = elements[0]
          const records = elements[1].records
          return _.flatMap(records, x => refillAttributes(cls, x.get('a'), session))
        })
    )
    .then(elements => filterClassHierarchy(elements))
    .then(elements => new Map(_.map(elements, e => [uuid.unparse(jsmf.jsmfId(e)), e])))
    .then(elements => refillReferences(classes, elements, session))
    .then(values => new jsmf.Model('LoadedModel', mm, Array.from(values.values())))
}

function loadElements(cls, session) {
  const query = `MATCH (a:${cls.__name}) RETURN (a)`
  return session.run(query).then(x => [cls, x])
}

function refillAttributes(cls, e) {
  const res = cls.newInstance()
  _.forEach(cls.getAllAttributes(), (t, x) => res[x] = e.properties[x])
  res.__jsmf__.uuid = uuid.parse(e.properties.__jsmf__)
  setAsStored(res)
  return res
}

function setAsStored(e) {
  e.__jsmf__.storedIn = driver._url
}

function filterClassHierarchy(elements) {
  const res = _.reduce(elements, (acc, e) => checkElement(acc, e), new Map())
  return Array.from(res.values())
}

function checkElement(m, elem) {
  const elemId = uuid.unparse(jsmf.jsmfId(elem))
  const old = m.get(elemId)
  if (old === undefined) { m.set(elemId, elem) }
  else {
    const oldClasses = old.conformsTo().getInheritanceChain()
    if (!_.includes(oldClasses, elem.conformsTo())) {
      m.set(elemId, elem)
    }
  }
  return m
}

function refillReferences(classes, elements, session) {
  const silentProperties = new Set()
  return Promise.all(
      _(classes).flatMap(x => _.map(x.getAllReferences(), (ref, refName) => [x, ref, refName]))
            .map(x => refillReference(x[2], x[0], x[1], elements, silentProperties, session))
            .value()).then(() => elements)
}

function refillReference(refName, cls, ref, elements, silentProperties, session) {
  if (silentProperties.has(refName)) { return undefined }
  silentProperties.add(refName)
  if (ref.opposite != undefined) { silentProperties.add(ref.opposite)}
  const query = `MATCH (s:${cls.__name})-[a:${refName}]->(t:${ref.type.__name}) RETURN s, t, a`
  return session.run(query)
    .then(res => _.map(res.records,
                  rec => resolveReference(refName, cls, rec.get('s'),
                                          ref.type, rec.get('t'),
                                          ref.associated, rec.get('a'),
                                          elements)))
}

function resolveReference(name, srcClass, s, targetClass, t, associatedClass, a, elements) {
  const source = resolveElement(srcClass, s, elements)
  const target = resolveElement(targetClass, t, elements)
  const setterName = 'add' + name[0].toUpperCase() + name.slice(1)
  if (!_.isEmpty(a.properties)) {
    const associated = resolveElement(associatedClass, a, elements)
    source[setterName](target, associated)
  } else {
    source[setterName](target)
  }
}

function resolveElement(cls, e, elements) {
  const key = e.properties.__jsmf__
  let res = elements.get(key)
  if (!res) {
    res = refillAttributes(cls, e)
    elements.set(key, res)
  }
  return res
}

function saveElements(es, reified, ownTypes, session) {
  return Promise.all(_.map(es, x => saveElement(x, reified, ownTypes, session))).then(v => new Map(v))
}

function saveElement(elt, reified, ownTypes, session) {
  const e = reified.get(elt) || elt
  const dry = dryElement(e, ownTypes)
  const classes = _.map(e.conformsTo().getInheritanceChain(), '__name')
  classes.push('JSMF')
  if (e.__jsmf__.storedIn === driver._url) {
    const clean = 'MATCH (x {__jsmf__: {jsmfId}}) DETACH DELETE x'
    const update = `MERGE (x:${classes.join(':')} {__jsmf__: {jsmfId}}) SET x = {params} RETURN (x)`
    return session.run(clean, {jsmfId: dry.__jsmf__})
      .then(() => session.run(update, {params: dry, jsmfId: dry.__jsmf__}))
      .then(v => { setAsStored(e); return [e, v.records[0].get(0).identity]})
      .catch(err => Promise.reject(new Error(`Error with element: ${dry}`)))
  } else {
    const query = `CREATE (x:${classes.join(':')} {params}) RETURN (x)`
    return session.run(query, {params: dry})
      .catch(() => storeDuplicatedIdElement(classes, e, dry, session))
      .then(v => { setAsStored(e); return [e, v.records[0].get(0).identity]})
      .catch(err => Promise.reject(new Error(`Error with element: ${dry}`)))
  }
}

function storeDuplicatedIdElement(classes, e, dry, session) {
  const newId = jsmf.generateId()
  e.__jsmf__.uuid = newId
  dry.__jsmf__ = uuid.unparse(newId)
  const query = `CREATE (x:${classes.join(':')} {params}) RETURN (x)`
  return session.run(query, {params: dry})
    .then(v => { setAsStored(e); return [e, v.records[0].get(0).identity]})
    .catch(() => storeDuplicatedIdElement(classes, e, dry, session))
}

function saveRelationships(es, elemMap, reified, ownTypes, session) {
  const relations = _.flatMap(es, e => saveElemRelationships(e, elemMap, reified, ownTypes, session))
  return Promise.all(relations)
}

function saveElemRelationships(elt, elemMap, reified, ownTypes, session) {
  const e = reified.get(uuid.unparse(jsmf.jsmfId(elt))) || elt
  const references = e.conformsTo().getAllReferences()
  return _.flatMap(references, (v, r) => saveElemRelationship(e, r, elemMap, reified, ownTypes, session))
}

function saveElemRelationship(e, ref, elemMap, reified, ownTypes, session) {
  const associated = new Map(_.map(e.getAssociated(ref), a => [a.elem, a.associated]))
  const referenced = e[ref]
  return _.map(referenced, t => saveRelationship(e, ref, t, associated.get(t), elemMap, reified, ownTypes, session))
}

function saveRelationship(source, ref, t, associated, elemMap, reified, ownTypes, session) {
  const target = reified.get(uuid.unparse(jsmf.jsmfId(t))) || t
  const statements = [ 'MATCH (s) WHERE id(s) in { sourceId }'
                     , 'MATCH (t) WHERE id(t) in { targetId }'
                     , `CREATE (s) -[r:${ref}${associated ? ' { associated }' : ''}]-> (t)`
                     , 'RETURN r'
                     ]
  const sourceId = elemMap.get(source)
  let targetId = elemMap.get(target)
  if (!targetId) {
    elemMap.set(...saveElement(target, reified, ownTypes, session))
    targetId = elemMap.get(target)
  }
  if (associated !== undefined) {
    const associatedId = elemMap.get(associated)
    if (associatedId === undefined) {
      saveElement(associated, reified, ownTypes, session)
    }
    associated = associated ? dryElement(associated) : undefined
  }
  const params = Object.assign({sourceId, targetId}, associated!==undefined?{associated}:{})
  return session.run(statements.join(' '), params)
      .then(() => console.log(`OK reference: ${params.sourceId} - ${ref} - ${params.targetId}`))
      .catch(err => {console.log(err); return Promise.reject(new Error(`Error with reference: ${params.sourceId} - ${ref} - ${params.targetId}`))})
}

function dryElement(e) {
  const attributes = e.conformsTo().getAllAttributes()
  const jid = uuid.unparse(jsmf.jsmfId(e))
  return _.reduce(attributes,
    function (res, a, k) {
      if (e[k] !== undefined) { res[k] = e[k] }
      return res
    },
    {__jsmf__: jid})
}

function reifyMetaElement(elt, reified, ownTypes) {
  const cached = reified.get(elt)
  if (cached) {return cached}
  const rModel = r.reifyModel(elt, reified, ownTypes)
  if (rModel) return [rModel]
  const rClass = r.reifyClass(elt, reified, ownTypes)
  if (rClass) return (new jsmf.Model('', undefined, rClass, true)).elements()
  const rEnum = r.reifyEnum(elt, reified, ownTypes)
  if (rEnum) return (new jsmf.Model('', undefined, rEnum, true)).elements()
  return [elt]
}
