const url = require('url')
const crypto = require('crypto')
const normalUrl = require('normalize-url')
const querystring = require('querystring')
const fetch = require('@zeit/fetch-retry')(require('node-fetch'), {retries: 3})

// The Firebase Admin SDK to access the FireStore DB.
const functions = require('firebase-functions')
const admin = require('firebase-admin')

const { getSupportedDomain, loadRules } = require('./parser/utils')
const { collection } = require('./constants')

// Setting DB
admin.initializeApp(functions.config().firebase)
var db = admin.firestore()
db.settings({timestampsInSnapshots: true})

// Setting functions region
const httpsFunctions = functions.https
const asiaRegion = 'asia-northeast1'

const ruleDir = __dirname + '/../config'
const supportedDomain = getSupportedDomain(ruleDir)
const parseRules = loadRules(ruleDir)
const domain_colors = Object.keys(parseRules)
                            .reduce((result, key) => {
                              result[key] = parseRules[key].color
                              return result
                            }, {})

const IS_PROD = process.env.GCP_PROJECT && process.env.FUNCTION_REGION ? true : false
console.log(`IS_PROD: ${IS_PROD} `
            + `GCP_PROJECT="${process.env.GCP_PROJECT}" `
            + `FUNCTION_REGION="${process.env.FUNCTION_REGION}"`)

/**
 * Normalize url with default config 
 * 
 * @param u {string} URL to normalize
 * @return {string}
 */
const normalizeUrl = u => {
  const normalizeUrlConfig = {
    forceHttps: true,
    stripHash: true,
    stripWWW: true,
    removeTrailingSlash: true,
    removeQueryParameters: [/.*/] // Remove all query parameters
  }

  try {
    return normalUrl(u, normalizeUrlConfig)
  } catch(e) {
    console.error(`Error parse url=${u}, ${e}`)
    throw new Error(e)
  }
}

/**
 * Get config from firebase config
 * config().pricetrack.<KEY>
 * 
 * @param key {string} Key to get
 * @param default_val {object}
 * @return {object}
 */
const getConfig = (key, default_val=false) => {
  const config_set = functions.config().pricetrack || {}
  return config_set[key] || default_val
}

/**
 * Get sort key from req.params
 * @param  {[type]} key [description]
 * @return {[type]}     [description]
 */
const getSortKey = key => {
  const default_key = 'created_at'
  const validKeys = ['created_at', 'last_pull_at', 'created_at', 
                     'last_update_at', 'price_change', 'price_change_at']
  if (!key || validKeys.indexOf(key) == -1) return default_key
  return key
}

/**
 * Format price
 * @param  {[type]}  price     [description]
 * @param  {Boolean} plus_sign [description]
 * @param  {String}  currency  [description]
 * @return {[type]}            [description]
 */
const formatPrice = (price, plus_sign = false, currency = 'VND') => {
    if (!price) return ''
    let sign = plus_sign && price > 0 ? '+' : ''
    return sign + price.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + ' ' + currency
}

/**
 * Verify User Token (Google Token)
 * @param  {string} token.    Token to verify
 * @param  {function} success success callback function
 * @param  {function} error   error callback function
 */
const verifyUserTokenId = (token, success, error) => {
  admin.auth().verifyIdToken(idToken)
    .then(function(decodedToken) {
      var uid = decodedToken.uid;
      success(uid)
    }).catch(function(err) {
      error(err)
    })
}

/**
 * Node fetch with retry
 * @param  {string} url
 * @param  {object} options
 * @return {[type]} fetch object
 */
const fetchRetry = (url, options) => fetch(url, options)

/**
 * Firebase functions url
 * @type {[type]}
 */
const functionsUrl = !IS_PROD
  ? `http://localhost:5001/duyet-price-tracker/us-central1`
  : `https://${process.env.FUNCTION_REGION}-${process.env.GCP_PROJECT}.cloudfunctions.net`
const functionsUrlAsia = !IS_PROD
  ? `http://localhost:5001/duyet-price-tracker/us-central1`
  : `https://asia-northeast1-${process.env.GCP_PROJECT}.cloudfunctions.net`


/**
 * Hosting root url
 * @type {[type]}
 */
const hostingUrl = !IS_PROD
  ? `http://localhost:8000`
  : getConfig('hosting_url', 'https://tracker.duyet.net')


module.exports = {
  db,
  httpsFunctions,
  asiaRegion,
  supportedDomain,
  parseRules,

  // List of collections
  collection,
  functionsUrl,
  functionsUrlAsia,
  hostingUrl,
  domain_colors,
  normalizeUrl,
  querystring,

  // Normalize and Hash URL
  hash: u => crypto.createHash('sha1').update(normalizeUrl(u)).digest('hex'),

  // TODO: clean email
  cleanEmail: e => e,

  // Check is in supported domain
  isSupportedUrl: u => supportedDomain.indexOf(url.parse(normalizeUrl(u)).hostname) > -1,

  domainOf: u => {
    let parsed = url.parse(normalizeUrl(u))
    if (!parsed) return ''
    return parsed.hostname || ''
  },

  // Url parser
  urlParser: require('./parser/index'),

  // Get domain name
  getHostname: u => url.parse(u).hostname,

  /**
   * Make url link:
   *
   * e.g. 
   *   - url_for('/abc', {key: value})
   *   - https://domain.com/abc?key=value 
   */
  url_for: (path, qs) => {
    let query = Object
      .entries(qs)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')

    if (qs.hasOwnProperty('region') && qs.region == 'asia') {
      return functionsUrlAsia + '/' + path + '?' + query
    }

    return functionsUrl + '/' + path + '?' + query
  },

  // Get Firebase Functions env config
  getConfig,

  // redash format JSON
  // e.g. {columns: [], rows: []}
  redash_format: json_list => {
    if (!json_list.length) return { columns: [], rows: [] }
    const type_of = val => {
      let t = typeof val
      const map = {
        'object': 'string',
        'number': 'interger'
      }
      if (t in map) return map[t]
      return t
    }

    let keys = Object.keys(json_list[0])
    return {
      columns: keys.map(key => { return { name: key, type: type_of(json_list[0][key]) } }),
      rows: json_list
    }
  },

  /**
   * Return hash from url, if it already hashed, skip it
   * 
   * @param s {string} url hash or url
   * @return {string}
   */
  documentIdFromHashOrUrl: s => {
    str = String(s)
    return (/^[a-fA-F0-9]+$/).test(s) 
              ? s 
              : crypto.createHash('sha1').update(normalizeUrl(str)).digest('hex')
  },

  /**
   * Validate token, compare with pricetrack.admin_token
   * Set token by: $ firebase functions:config:set pricetrack.admin_token=<YOUR_TOKEN>
   * 
   * @param token {string} validate admin token
   * @return {bool}
   */
  validateToken: token => {
    const adminToken = getConfig('admin_token')
    return token && adminToken === token
  },

  getSortKey,
  formatPrice,
  verifyUserTokenId,
  fetchRetry
}
