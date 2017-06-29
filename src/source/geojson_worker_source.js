// @flow

const ajax = require('../util/ajax');
const rewind = require('geojson-rewind');
const GeoJSONWrapper = require('./geojson_wrapper');
const vtpbf = require('vt-pbf');
const supercluster = require('supercluster');
const geojsonvt = require('geojson-vt');

const VectorTileWorkerSource = require('./vector_tile_worker_source');

import type {
    WorkerTileParameters,
    WorkerTileCallback,
} from '../source/source';

import type {Actor} from '../util/actor';
import type {StyleLayerIndex} from '../style/style_layer_index';

import type {LoadVectorDataCallback} from './vector_tile_worker_source';

export type GeoJSON = Object;

export type LoadGeoJSONParameters = {
    url?: string,
    data?: string,
    source: string,
    superclusterOptions?: Object,
    geojsonVtOptions?: Object
};

export type LoadGeoJSON = (params: LoadGeoJSONParameters, callback: Callback<GeoJSON>) => void;

export interface GeoJSONIndex {
}

function loadGeoJSONTile(params: WorkerTileParameters, callback: LoadVectorDataCallback) {
    const source = params.source,
        coord = params.coord;

    if (!this._geoJSONIndexes[source]) {
        return callback(null, null);  // we couldn't load the file
    }

    const geoJSONTile = this._geoJSONIndexes[source].getTile(Math.min(coord.z, params.maxZoom), coord.x, coord.y);
    if (!geoJSONTile) {
        return callback(null, null); // nothing in the given tile
    }

    // Encode the geojson-vt tile into binary vector tile form form.  This
    // is a convenience that allows `FeatureIndex` to operate the same way
    // across `VectorTileSource` and `GeoJSONSource` data.
    const geojsonWrapper = new GeoJSONWrapper(geoJSONTile.features);
    geojsonWrapper.name = '_geojsonTileLayer';
    let pbf = vtpbf({ layers: { '_geojsonTileLayer': geojsonWrapper }});
    if (pbf.byteOffset !== 0 || pbf.byteLength !== pbf.buffer.byteLength) {
        // Compatibility with node Buffer (https://github.com/mapbox/pbf/issues/35)
        pbf = new Uint8Array(pbf);
    }
    geojsonWrapper.rawData = pbf.buffer;
    callback(null, geojsonWrapper);
}

/**
 * The {@link WorkerSource} implementation that supports {@link GeoJSONSource}.
 * This class is designed to be easily reused to support custom source types
 * for data formats that can be parsed/converted into an in-memory GeoJSON
 * representation.  To do so, create it with
 * `new GeoJSONWorkerSource(actor, layerIndex, customLoadGeoJSONFunction)`.
 * For a full example, see [mapbox-gl-topojson](https://github.com/developmentseed/mapbox-gl-topojson).
 *
 * @private
 */
class GeoJSONWorkerSource extends VectorTileWorkerSource {
    _geoJSONIndexes: { [string]: GeoJSONIndex };
    loadGeoJSON: LoadGeoJSON;

    /**
     * @param [loadGeoJSON] Optional method for custom loading/parsing of
     * GeoJSON based on parameters passed from the main-thread Source.
     * See {@link GeoJSONWorkerSource#loadGeoJSON}.
     */
    constructor(actor: Actor, layerIndex: StyleLayerIndex, loadGeoJSON: ?LoadGeoJSON) {
        super(actor, layerIndex, loadGeoJSONTile);
        if (loadGeoJSON) {
            this.loadGeoJSON = loadGeoJSON;
        }
        // object mapping source ids to geojson-vt-like tile indexes
        this._geoJSONIndexes = {};
    }

    /**
     * Fetches (if appropriate), parses, and index geojson data into tiles. This
     * preparatory method must be called before {@link GeoJSONWorkerSource#loadTile}
     * can correctly serve up tiles.
     *
     * Defers to {@link GeoJSONWorkerSource#loadGeoJSON} for the fetching/parsing,
     * expecting `callback(error, data)` to be called with either an error or a
     * parsed GeoJSON object.
     * @param params
     * @param params.source The id of the source.
     * @param callback
     */
    loadData(params: LoadGeoJSONParameters, callback: Callback<void>) {
        this.loadGeoJSON(params, (err, data) => {
            if (err || !data) {
                return callback(err);
            } else if (typeof data !== 'object') {
                return callback(new Error("Input data is not a valid GeoJSON object."));
            } else {
                rewind(data, true);

                try {
                    this._geoJSONIndexes[params.source] = params.cluster ?
                        supercluster(params.superclusterOptions).load(data.features) :
                        geojsonvt(data, params.geojsonVtOptions);
                } catch (err) {
                    return callback(err);
                }

                this.loaded[params.source] = {};
                callback(null);
            }
        });
    }

    /**
    * Implements {@link WorkerSource#reloadTile}.
    *
    * If the tile is loaded, uses the implementation in VectorTileWorkerSource.
    * Otherwise, such as after a setData() call, we load the tile fresh.
    *
    * @param params
    * @param params.source The id of the source for which we're loading this tile.
    * @param params.uid The UID for this tile.
    */
    reloadTile(params: WorkerTileParameters, callback: WorkerTileCallback) {
        const loaded = this.loaded[params.source],
            uid = params.uid;

        if (loaded && loaded[uid]) {
            return super.reloadTile(params, callback);
        } else {
            return this.loadTile(params, callback);
        }
    }

    /**
     * Fetch and parse GeoJSON according to the given params.  Calls `callback`
     * with `(err, data)`, where `data` is a parsed GeoJSON object.
     *
     * GeoJSON is loaded and parsed from `params.url` if it exists, or else
     * expected as a literal (string or object) `params.data`.
     *
     * @param params
     * @param [params.url] A URL to the remote GeoJSON data.
     * @param [params.data] Literal GeoJSON data. Must be provided if `params.url` is not.
     */
    loadGeoJSON(params: LoadGeoJSONParameters, callback: Callback<GeoJSON>) {
        // Because of same origin issues, urls must either include an explicit
        // origin or absolute path.
        // ie: /foo/bar.json or http://example.com/bar.json
        // but not ../foo/bar.json
        if (params.url) {
            ajax.getJSON(params.url, callback);
        } else if (typeof params.data === 'string') {
            try {
                return callback(null, JSON.parse(params.data));
            } catch (e) {
                return callback(new Error("Input data is not a valid GeoJSON object."));
            }
        } else {
            return callback(new Error("Input data is not a valid GeoJSON object."));
        }
    }

    removeSource(params: {source: string}) {
        if (this._geoJSONIndexes[params.source]) {
            delete this._geoJSONIndexes[params.source];
        }
    }

    /**
     * Index the data using either geojson-vt or supercluster
     * @param {GeoJSON} data
     * @param {Object} params forwarded from loadTile.
     * @param {callback} (err, indexedData)
     * @private
     */
    _indexData(data, params, callback) {
        try {
            if (params.cluster) {
                let superclusterOptions = params.superclusterOptions;

                if (params.clusterMapProperties) {
                    superclusterOptions.initial = function () {
                        let initial = {};

                        params.clusterMapProperties.forEach(function (key) {
                            initial[key] = [];
                        });

                        return initial;
                    };
                    superclusterOptions.reduce = function (accumulated, props) {
                        params.clusterMapProperties.forEach(function (key) {
                            if (props[key]) {
                                accumulated[key].push(props[key]);
                            }
                        });

                        return accumulated;
                    };
                }

                callback(null, supercluster(superclusterOptions).load(data.features));
            } else {
                callback(null, geojsonvt(data, params.geojsonVtOptions));
            }
        } catch (err) {
            return callback(err);
        }
    }
}

module.exports = GeoJSONWorkerSource;
