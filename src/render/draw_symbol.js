'use strict';

const browser = require('../util/browser');
const drawCollisionDebug = require('./draw_collision_debug');
const pixelsToTileUnits = require('../source/pixels_to_tile_units');

module.exports = drawSymbols;

function drawSymbols(painter, sourceCache, layer, coords) {
    if (painter.isOpaquePass) return;

    const drawAcrossEdges =
        !layer.layout['text-allow-overlap'] &&
        !layer.layout['icon-allow-overlap'] &&
        !layer.layout['text-ignore-placement'] &&
        !layer.layout['icon-ignore-placement'];

    const gl = painter.gl;

    // Disable the stencil test so that labels aren't clipped to tile boundaries.
    //
    // Layers with features that may be drawn overlapping aren't clipped. These
    // layers are sorted in the y direction, and to draw the correct ordering near
    // tile edges the icons are included in both tiles and clipped when drawing.
    if (drawAcrossEdges) {
        gl.disable(gl.STENCIL_TEST);
    } else {
        gl.enable(gl.STENCIL_TEST);
    }

    painter.setDepthSublayer(0);
    painter.depthMask(false);

    drawLayerSymbols(painter, sourceCache, layer, coords, false,
        layer.paint['icon-translate'],
        layer.paint['icon-translate-anchor'],
        layer.layout['icon-rotation-alignment'],
        // icon-pitch-alignment is not yet implemented
        // and we simply inherit the rotation alignment
        layer.layout['icon-rotation-alignment']
    );

    drawLayerSymbols(painter, sourceCache, layer, coords, true,
        layer.paint['text-translate'],
        layer.paint['text-translate-anchor'],
        layer.layout['text-rotation-alignment'],
        layer.layout['text-pitch-alignment']
    );

    if (sourceCache.map.showCollisionBoxes) {
        drawCollisionDebug(painter, sourceCache, layer, coords);
    }
}

function drawLayerSymbols(painter, sourceCache, layer, coords, isText, translate, translateAnchor,
        rotationAlignment, pitchAlignment) {

    if (!isText && painter.style.sprite && !painter.style.sprite.loaded())
        return;

    const gl = painter.gl;

    const rotateWithMap = rotationAlignment === 'map';
    const pitchWithMap = pitchAlignment === 'map';

    const depthOn = pitchWithMap;

    if (depthOn) {
        gl.enable(gl.DEPTH_TEST);
    } else {
        gl.disable(gl.DEPTH_TEST);
    }

    let program, prevFontstack;

    for (const coord of coords) {
        const tile = sourceCache.getTile(coord);
        const bucket = tile.getBucket(layer);
        if (!bucket) continue;
        const buffers = isText ? bucket.buffers.glyph : bucket.buffers.icon;
        if (!buffers || !buffers.segments.length) continue;
        const layerData = buffers.layerData[layer.id];
        const programConfiguration = layerData.programConfiguration;

        const isSDF = isText || bucket.sdfIcons;

        if (!program || bucket.fontstack !== prevFontstack) {
            program = painter.useProgram(isSDF ? 'symbolSDF' : 'symbolIcon', programConfiguration);
            programConfiguration.setUniforms(gl, program, layer, {zoom: painter.transform.zoom});

            setSymbolDrawState(program, painter, layer, coord.z, isText, isSDF, rotateWithMap, pitchWithMap, bucket.fontstack, bucket.iconsNeedLinear);
        }

        painter.enableTileClippingMask(coord);

        gl.uniformMatrix4fv(program.u_matrix, false,
                painter.translatePosMatrix(coord.posMatrix, tile, translate, translateAnchor));

        drawTileSymbols(program, painter, layer, tile, buffers, isText, isSDF,
                pitchWithMap);

        prevFontstack = bucket.fontstack;
    }

    if (!depthOn) gl.enable(gl.DEPTH_TEST);
}

function setSymbolDrawState(program, painter, layer, tileZoom, isText, isSDF, rotateWithMap, pitchWithMap, fontstack, iconsNeedLinear) {

    const gl = painter.gl;
    const tr = painter.transform;

    gl.uniform1i(program.u_rotate_with_map, rotateWithMap);
    gl.uniform1i(program.u_pitch_with_map, pitchWithMap);

    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(program.u_texture, 0);

    gl.uniform1f(program.u_is_text, isText ? 1 : 0);

    if (isText) {
        // use the fonstack used when parsing the tile, not the fontstack
        // at the current zoom level (layout['text-font']).
        const glyphAtlas = fontstack && painter.glyphSource.getGlyphAtlas(fontstack);
        if (!glyphAtlas) return;

        glyphAtlas.updateTexture(gl);
        gl.uniform2f(program.u_texsize, glyphAtlas.width / 4, glyphAtlas.height / 4);
    } else {
        const mapMoving = painter.options.rotating || painter.options.zooming;
        const iconSizeScaled = !layer.isLayoutValueFeatureConstant('text-size') ||
            !layer.isLayoutValueZoomConstant('text-size') ||
            layer.getLayoutValue('text-size', { zoom: tr.zoom }, {}) !== 1;
        const iconScaled = iconSizeScaled || browser.devicePixelRatio !== painter.spriteAtlas.pixelRatio || iconsNeedLinear;
        const iconTransformed = pitchWithMap || tr.pitch;
        painter.spriteAtlas.bind(gl, isSDF || mapMoving || iconScaled || iconTransformed);
        gl.uniform2f(program.u_texsize, painter.spriteAtlas.width / 4, painter.spriteAtlas.height / 4);
    }

    gl.activeTexture(gl.TEXTURE1);
    painter.frameHistory.bind(gl);
    gl.uniform1i(program.u_fadetexture, 1);

    // adjust min/max zooms for variable font sizes
    gl.uniform1f(program.u_zoom, tr.zoom);

    gl.uniform1f(program.u_pitch, tr.pitch / 360 * 2 * Math.PI);
    gl.uniform1f(program.u_bearing, tr.bearing / 360 * 2 * Math.PI);
    gl.uniform1f(program.u_aspect_ratio, tr.width / tr.height);
}

function drawTileSymbols(program, painter, layer, tile, buffers, isText, isSDF,
        pitchWithMap) {

    const gl = painter.gl;
    const tr = painter.transform;

    // If {text,icon}-size is a composite function, the shader needs to
    // evaluate it at the zoom level that was used at *layout* time, which
    // is distinct the current *rendered* zoom level.
    const sizeProperty = isText ? 'text-size' : 'icon-size';
    const isSizeCompositeFunction =
        !layer.isLayoutValueZoomConstant(sizeProperty) &&
        !layer.isLayoutValueFeatureConstant(sizeProperty);
    gl.uniform1f(program.u_is_size_composite, isSizeCompositeFunction ? 1 : 0);

    const layoutZoom = tile.coord.z + 1;
    if (isSizeCompositeFunction) {
        gl.uniform1f(program.u_adjusted_size_t,
            layer.getLayoutInterpolationT(sizeProperty, { zoom: layoutZoom }));
    } else {
        gl.uniform1f(program.u_adjusted_size,
            layer.getLayoutValue(sizeProperty, { zoom: layoutZoom })
        );
    }

    if (pitchWithMap) {
        const s = pixelsToTileUnits(tile, 1, tr.zoom);
        gl.uniform2f(program.u_extrude_scale, s, s);
    } else {
        const s = tr.cameraToCenterDistance;
        gl.uniform2f(program.u_extrude_scale,
            tr.pixelsToGLUnits[0] * s,
            tr.pixelsToGLUnits[1] * s);
    }

    if (isSDF) {
        const haloWidthProperty = `${isText ? 'text' : 'icon'}-halo-width`;
        const hasHalo = !layer.isPaintValueFeatureConstant(haloWidthProperty) || layer.paint[haloWidthProperty];
        const gammaScale = (isText ? 1 / 24 : 1) * (pitchWithMap ? Math.cos(tr._pitch) : 1) * tr.cameraToCenterDistance;
        gl.uniform1f(program.u_gamma_scale, gammaScale);

        if (hasHalo) { // Draw halo underneath the text.
            gl.uniform1f(program.u_is_halo, 1);
            drawSymbolElements(buffers, layer, gl, program);
        }

        gl.uniform1f(program.u_is_halo, 0);
    }

    drawSymbolElements(buffers, layer, gl, program);
}

function drawSymbolElements(buffers, layer, gl, program) {
    const layerData = buffers.layerData[layer.id];
    const paintVertexBuffer = layerData && layerData.paintVertexBuffer;

    for (const segment of buffers.segments) {
        segment.vaos[layer.id].bind(gl, program, buffers.layoutVertexBuffer, buffers.elementBuffer, paintVertexBuffer, segment.vertexOffset);
        gl.drawElements(gl.TRIANGLES, segment.primitiveLength * 3, gl.UNSIGNED_SHORT, segment.primitiveOffset * 3 * 2);
    }
}
