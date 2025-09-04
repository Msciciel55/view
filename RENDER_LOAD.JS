const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

class GothicRenderSystem {
    constructor() {
        this.renderer = null;
        this.scene = null;
        this.camera = null;
        this.modelCache = new Map();
        this.textureCache = new Map();
        this.isInitialized = false;
        this.sharedRenderTarget = null;
        this.ambientLight = null;
        this.directionalLight = null;
    }

    initialize() {
        if (this.isInitialized) return;

        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        canvas.style.display = 'none';
        document.body.appendChild(canvas);

        this.renderer = new THREE.WebGLRenderer({
            canvas: canvas,
            antialias: true,
            alpha: true,
            preserveDrawingBuffer: true
        });

        this.renderer.setSize(256, 256);
        this.renderer.setClearColor(0x000000, 0);

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);

        this.ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(this.ambientLight);

        this.directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        this.directionalLight.position.set(5, 5, 5);
        this.scene.add(this.directionalLight);

        this.isInitialized = true;

        this.sharedRenderTarget = new THREE.WebGLRenderTarget(256, 256, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat
        });
    }

    /**
     * MODIFIED: This function now loads textures from the global `window.fileMap`
     * instead of using `fetch` with the `vdfs://` protocol.
     */
    async loadTexture(url) {
        const textureFilename = url.split('/').pop().toUpperCase();
        if (this.textureCache.has(textureFilename)) {
            return this.textureCache.get(textureFilename);
        }

        try {
            if (!window.fileMap || !window.fileMap.has(textureFilename)) {
                throw new Error(`Texture not found in loaded files: ${textureFilename}`);
            }
            const buffer = window.fileMap.get(textureFilename);
            const texLoader = new TEXLoader();
            const texture = texLoader.load(buffer);
            this.textureCache.set(textureFilename, texture);
            return texture;
        } catch (error) {
            console.warn(`Failed to load texture ${textureFilename}:`, error);
            return null;
        }
    }

    /**
     * MODIFIED: This function now loads models from the global `window.fileMap`
     * instead of using `fetch` with the `vdfs://` protocol.
     */
    async loadModel(url) {
        const modelFilename = url.split('/').pop().toUpperCase();
        if (this.modelCache.has(modelFilename)) {
            return this.modelCache.get(modelFilename);
        }

        try {
            if (!window.fileMap || !window.fileMap.has(modelFilename)) {
                throw new Error(`Model not found in loaded files: ${modelFilename}`);
            }
            const buffer = window.fileMap.get(modelFilename);

            const fileExtension = modelFilename.split('.').pop().toUpperCase();
            let loader;

            switch (fileExtension) {
                case 'MDL': loader = new MDLLoader(); break;
                case 'MDM': loader = new MDMLoader(); break;
                case 'MMB': loader = new MMBLoader(); break;
                default: loader = new MRMLoader(); break;
            }

            const textureMap = await this.preloadTexturesForModel(loader, buffer.slice(0), fileExtension);
            loader.setTextures(textureMap);
            
            // The buffer needs to be passed again as it was consumed by preloadTexturesForModel
            const finalBuffer = window.fileMap.get(modelFilename);
            const model = loader.load(finalBuffer);
            this.modelCache.set(modelFilename, model);
            return model;
        } catch (error) {
            console.error(`Failed to load model ${modelFilename}:`, error);
            return null;
        }
    }

    async preloadTexturesForModel(loader, buffer, fileExtension) {
        const textureMap = new Map();
        try {
            // Note: This logic now implicitly uses our modified `loadTexture` function,
            // which checks `window.fileMap` instead of fetching from `vdfs`.
            if (fileExtension === 'MRM') {
                 // MRMLoader consumes the buffer, so a fresh one is needed for the actual load.
                 // The loader needs to parse materials to find texture names.
                const tempLoader = new MRMLoader();
                tempLoader.load(buffer);
                for (const material of tempLoader.materials) {
                    if (material.texture) {
                        const texUrl = `vdfs://_WORK/DATA/TEXTURES/_COMPILED/${material.texture}-C.TEX`;
                        const texture = await this.loadTexture(texUrl);
                        if (texture) textureMap.set(material.texture.toUpperCase(), texture);
                    }
                }
            } else if (fileExtension === 'MDL' || fileExtension === 'MDM' || fileExtension === 'MMB') {
                const tempLoader = fileExtension === 'MDL' ? new MDLLoader() :
                    fileExtension === 'MDM' ? new MDMLoader() : new MMBLoader();
                
                tempLoader.setTextures(new Map()); // Use a dummy map for preloading
                const tempModel = tempLoader.load(buffer); // This will parse material names
                const allMaterials = new Set();
                
                // Extract material names which are often used as texture names
                if(tempLoader.materials) {
                     for (const material of tempLoader.materials) {
                        if (material.texture) {
                           allMaterials.add(material.texture.toUpperCase());
                        }
                    }
                }
                 if(tempLoader.mesh && tempLoader.mesh.meshes) {
                     for(const softSkin of tempLoader.mesh.meshes) {
                         if(softSkin.mesh) {
                            softSkin.mesh.traverse((child) => {
                                if (child.isMesh && child.material.userData.materialName) {
                                    allMaterials.add(child.material.userData.materialName.toUpperCase());
                                }
                                if (child.isMesh && child.material.userData.textureName) {
                                    allMaterials.add(child.material.userData.textureName.toUpperCase());
                                }
                            });
                         }
                     }
                 }


                for (const materialName of allMaterials) {
                    const texUrl = `vdfs://_WORK/DATA/TEXTURES/_COMPILED/${materialName}-C.TEX`;
                    const texture = await this.loadTexture(texUrl);
                    if (texture) textureMap.set(materialName, texture);
                }
            }
        } catch (e) {
            console.warn('Error pre-loading textures:', e);
        }
        return textureMap;
    }

    renderToCanvas(model, width, height, rotX = 0, rotY = 0, rotZ = 0, lightIntensity = 1.0, scale = 1.0) {
        if (!this.isInitialized) this.initialize();

        const renderTarget = this.sharedRenderTarget;
        if (renderTarget.width !== width || renderTarget.height !== height) {
            renderTarget.setSize(width, height);
        }

        this.scene.clear();
        this.ambientLight.intensity = 0.6 * lightIntensity;
        this.directionalLight.intensity = 0.8 * lightIntensity;
        this.scene.add(this.ambientLight);
        this.scene.add(this.directionalLight);

        const modelClone = model.clone();
        modelClone.rotation.set(rotX, rotY, rotZ);
        this.scene.add(modelClone);

        const box = new THREE.Box3().setFromObject(modelClone);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const baseDistance = Math.max(maxDim * 2.5, 0.1);

        this.camera.position.set(center.x, center.y, center.z + baseDistance);
        this.camera.lookAt(center);
        this.camera.aspect = width / height;

        const baseFov = 45;
        const rawFov = baseFov / scale;
        this.camera.fov = clamp(rawFov, 10, 75);
        this.camera.near = Math.max(0.001, baseDistance * 0.01);
        this.camera.far = baseDistance * 10;
        this.camera.updateProjectionMatrix();

        this.renderer.setRenderTarget(renderTarget);
        this.renderer.setSize(width, height);
        this.renderer.render(this.scene, this.camera);

        const pixels = new Uint8Array(width * height * 4);
        this.renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixels);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(width, height);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const srcIndex = ((height - 1 - y) * width + x) * 4;
                const dstIndex = (y * width + x) * 4;
                imageData.data[dstIndex] = pixels[srcIndex];
                imageData.data[dstIndex + 1] = pixels[srcIndex + 1];
                imageData.data[dstIndex + 2] = pixels[srcIndex + 2];
                imageData.data[dstIndex + 3] = pixels[srcIndex + 3];
            }
        }

        ctx.putImageData(imageData, 0, 0);
        this.renderer.setRenderTarget(null);
        return canvas;
    }
}

class GothicItemRender extends HTMLElement {
    constructor() {
        super();
        this.materialOverrides = new Map();
        this.model = null;
        this.canvas = null;
        this._width = 64;
        this._height = 64;
        this._rotX = 0;
        this._rotY = 0;
        this._rotZ = 0;
        this._lightIntensity = 1.0;
        this._scale = 1.0;
        this._visual = '';
    }

    static get observedAttributes() {
        return ['width', 'height', 'visual', 'rot-x', 'rot-y', 'rot-z', 'light-intensity', 'scale'];
    }

    connectedCallback() {
        this.style.display = 'inline-block';
        this.style.width = `${this._width}px`;
        this.style.height = `${this._height}px`;
        this.style.overflow = 'hidden';
        this.updateFromAttributes();
        this.loadAndRender();
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue) return;
        const updates = {
            'width': () => { this._width = parseInt(newValue) || 64; this.style.width = `${this._width}px`; },
            'height': () => { this._height = parseInt(newValue) || 64; this.style.height = `${this._height}px`; },
            'visual': () => { this._visual = newValue ? newValue.toUpperCase() : ''; },
            'rot-x': () => { this._rotX = parseFloat(newValue) || 0.0; },
            'rot-y': () => { this._rotY = parseFloat(newValue) || 0.0; },
            'rot-z': () => { this._rotZ = parseFloat(newValue) || 0.0; },
            'light-intensity': () => { this._lightIntensity = clamp(parseFloat(newValue) || 1.0, 0.0, 10.0); },
            'scale': () => { this._scale = clamp(parseFloat(newValue) || 1.0, 0.01, 10.0); }
        };

        if (updates[name]) {
            updates[name]();
            if (['width', 'height', 'rot-x', 'rot-y', 'rot-z', 'light-intensity', 'scale'].includes(name) && this.model) {
                this.renderModel();
            } else if (name === 'visual') {
                this.loadAndRender();
            }
        }
    }

    updateFromAttributes() {
        this._width = parseInt(this.getAttribute('width')) || 64;
        this._height = parseInt(this.getAttribute('height')) || 64;
        this._visual = this.getAttribute('visual') ? this.getAttribute('visual').toUpperCase() : '';
        this._rotX = parseFloat(this.getAttribute('rot-x')) || 0.0;
        this._rotY = parseFloat(this.getAttribute('rot-y')) || 0.0;
        this._rotZ = parseFloat(this.getAttribute('rot-z')) || 0.0;
        this._lightIntensity = clamp(parseFloat(this.getAttribute('light-intensity')) || 1.0, 0.0, 10.0);
        this._scale = clamp(parseFloat(this.getAttribute('scale')) || 1.0, 0.01, 10.0);
    }
    
    deepCloneModel(model) {
        const clonedModel = model.clone();
        clonedModel.traverse((child) => {
            if (child.isMesh && child.material) {
                child.material = child.material.clone();
                child.material.userData = { ...child.material.userData };
            }
        });
        return clonedModel;
    }

    async loadAndRender() {
        if (!this._visual) { this.showPlaceholder(); return; }
        try {
            // The original logic for determining paths is kept, even though
            // we only use the filename part for local loading. This maintains compatibility.
            let modelUrl;
            if (this._visual.endsWith('.MDL')) modelUrl = `vdfs://_WORK/DATA/ANIMS/_COMPILED/${this._visual}`;
            else if (this._visual.endsWith('.MDM')) modelUrl = `vdfs://_WORK/DATA/ANIMS/_COMPILED/${this._visual}`;
            else if (this._visual.endsWith('.MRM')) modelUrl = `vdfs://_WORK/DATA/MESHES/_COMPILED/${this._visual}`;
            else if (this._visual.endsWith('.MMB')) modelUrl = `vdfs://_WORK/DATA/ANIMS/_COMPILED/${this._visual}`;
            else modelUrl = `vdfs://_WORK/DATA/MESHES/_COMPILED/${this._visual}`;


            const originalModel = await gothicRenderSystem.loadModel(modelUrl);
            if (originalModel) {
                this.model = this.deepCloneModel(originalModel);
                this.renderModel();
            } else { this.showError(); }
        } catch (error) {
            console.error(`Error loading model ${this._visual}:`, error);
            this.showError();
        }
    }

    async renderModel() {
        if (!this.model) return;
        try {
            await this.applyMaterialOverrides();
            this.canvas = gothicRenderSystem.renderToCanvas(
                this.model, this._width, this._height, this._rotX, this._rotY, this._rotZ, this._lightIntensity, this._scale
            );
            this.innerHTML = '';
            this.appendChild(this.canvas);
        } catch (error) { console.error('Error rendering model:', error); this.showError(); }
    }

    async applyMaterialOverrides() {
        if (this.materialOverrides.size === 0) return;
        for (const [materialName, textureName] of this.materialOverrides) {
            const texUrl = `vdfs://_WORK/DATA/TEXTURES/_COMPILED/${textureName}-C.TEX`;
            const texture = await gothicRenderSystem.loadTexture(texUrl);
            this.model.traverse((child) => {
                if (child.isMesh && child.material && child.material.userData && child.material.userData.materialName === materialName) {
                    child.material.map = texture;
                    child.material.needsUpdate = true;
                }
            });
        }
    }

    showPlaceholder() { this.innerHTML = `<div style="width:100%;height:100%;background:#333;display:flex;align-items:center;justify-content:center;color:#666;font-size:12px;text-align:center;">No Model</div>`; }
    showError() { this.innerHTML = `<div style="width:100%;height:100%;background:#600;display:flex;align-items:center;justify-content:center;color:#f66;font-size:12px;text-align:center;">Error</div>`; }

    // Public API
    async setMaterialTexture(materialName, textureName) {
        this.materialOverrides.set(materialName.toUpperCase(), textureName.toUpperCase());
        if (this.model) { await this.renderModel(); }
    }

    getMaterialList() {
        if (!this.model) return [];
        const materials = new Map();
        this.model.traverse((child) => {
            if (child.isMesh && child.material && child.material.userData) {
                const materialName = child.material.userData.materialName || 'UNKNOWN';
                const currentTexture = child.material.userData.textureName || 'NO_TEXTURE';
                
                // If override exists, show the override instead of original
                const overrideTexture = this.materialOverrides.get(materialName.toUpperCase());
                materials.set(materialName, overrideTexture || currentTexture);
            }
        });
        return Array.from(materials.entries()).map(([name, texture]) => ({ materialName: name, currentTexture: texture }));
    }

    clearMaterialOverrides() {
        this.materialOverrides.clear();
        this.loadAndRender(); // Reload the original model to reset textures
    }
    
    setRotation(x, y, z) {
        this.setAttribute('rot-x', x.toString()); this.setAttribute('rot-y', y.toString()); this.setAttribute('rot-z', z.toString());
    }
    setLightIntensity(intensity) { this.setAttribute('light-intensity', intensity.toString()); }
    setScale(scale) { this.setAttribute('scale', scale.toString()); }
    isReady() { return this.model !== null; }
}

const gothicRenderSystem = new GothicRenderSystem();
customElements.define('gothic-render', GothicItemRender);

window.gothicRenderSystem = gothicRenderSystem;