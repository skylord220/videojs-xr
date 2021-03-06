import videojs from 'video.js';
import { version as VERSION } from '../package.json';
import 'babel-polyfill';
import WebXRPolyfill from 'webxr-polyfill';
import * as THREE from 'three';
import OrbitOrientationControls from './orbit-orientation-controls.js';
import CanvasPlayerControls from './canvas-player-controls';
import './big-vr-play-button';
import './cardboard-button';

const Plugin = videojs.getPlugin('plugin');

// Default options for the plugin.
const defaults = {};

class Xr extends Plugin {

    /**
     * Create a Xr plugin instance.
     *
     * @param  {Player} player
     *         A Video.js Player instance.
     *
     * @param  {Object} [options]
     *         An optional options object.
     *
     *         While not a core part of the Video.js plugin architecture, a
     *         second argument of options is a convenient way to accept inputs
     *         from your plugin's caller.
     */
    constructor(player, options) {
        // the parent class will add player under this.player
        super(player);

        this.options = videojs.mergeOptions(defaults, options);
        this.bigPlayButtonIndex_ = player.children().indexOf(player.getChild('BigPlayButton')) || 0;

        if (!navigator.xr)
            this.polyfill_ = new WebXRPolyfill();

        this.handleVrDisplayActivate_ = videojs.bind(this, this.handleVrDisplayActivate_);
        this.handleVrDisplayDeactivate_ = videojs.bind(this, this.handleVrDisplayDeactivate_);
        this.handleResize_ = videojs.bind(this, this.handleResize_);
        this.animate_ = videojs.bind(this, this.animate_);
        this.currentSession = null;

        this.on(player, 'loadedmetadata', this.init);

        this.player.ready(() => {
            this.player.addClass('vjs-xr');
        });
    }

    handleVrDisplayActivate_() {
        if (!this.xrSupported)
            return;

        if (this.animationFrameId_)
            this.cancelAnimationFrame(this.animationFrameId_);

        this.controls3d.disable();
        var self = this;
        var sessionInit = { optionalFeatures: ['local-floor'] };
        navigator.xr.requestSession('immersive-vr', sessionInit).then(function (session) {
            // handle exit from VR
            session.addEventListener('end', e => {
              console.log('session ended');
              window.dispatchEvent(new window.Event('vrdisplaydeactivate'));
            });

            self.renderer.xr.setSession(session);
            self.currentSession = session;
            session.requestReferenceSpace('local')
            .then((referenceSpace) => {
                self.xrReferenceSpace = referenceSpace;
                self.xrActive = true;
                self.trigger('xrSessionActivated');
                self.animationFrameId_ = self.requestAnimationFrame(self.animate_);
            })
        });
    }

    handleVrDisplayDeactivate_() {
        if (!this.xrSupported)
            return;

        if (this.animationFrameId_)
            this.cancelAnimationFrame(this.animationFrameId_);

        var self = this;
        this.currentSession.end().catch( e => {
          // Session already ended
          if (e.name == 'InvalidStateError') return;
          console.log(e);
        }).then(function () {
          self.xrActive = false;
          self.currentSession = null;
          self.renderer.xr.setSession(null);
          self.controls3d.enable();
          self.trigger('xrSessionDeactivated');
          self.animationFrameId_ = self.requestAnimationFrame(self.animate_);
        });
    }

    requestAnimationFrame(fn) {
        if (this.xrActive)
            return this.currentSession.requestAnimationFrame(fn);
        else
            return this.player.requestAnimationFrame(fn);
    }

    cancelAnimationFrame(id) {
        if (this.xrActive)
            return this.currentSession.cancelAnimationFrame(id);
        else
            return this.player.cancelAnimationFrame(id);
    }

    togglePlay_() {
        if (this.player.paused()) {
            this.player.play();
        } else {
            this.player.pause();
        }
    }

    animate_(xrTimestamp, xrFrame) {
        if (!this.initialized_) {
            return;
        }
        if (this.getVideoEl_().readyState === this.getVideoEl_().HAVE_ENOUGH_DATA) {
            if (this.videoTexture) {
                this.videoTexture.needsUpdate = true;
            }
        }

        this.camera.getWorldDirection(this.cameraVector);
        this.animationFrameId_ = this.requestAnimationFrame(this.animate_);

        if (!this.xrActive)
            this.controls3d.update();

        if (this.xrActive && xrFrame) {
            this.xrPose = xrFrame.getViewerPose(this.xrReferenceSpace);
            this.trigger('xrCameraUpdate');
        }
        
        this.renderer.render(this.scene, this.camera);
    }

    handleResize_() {
        const width = this.player.currentWidth();
        const height = this.player.currentHeight();

        this.renderer.setSize(width, height);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    init() {
        this.reset();

        this.xrSupported = false;
        this.camera = new THREE.PerspectiveCamera(75, this.player.currentWidth() / this.player.currentHeight(), 1, 1000);
        // Store vector representing the direction in which the camera is looking, in world space.
        this.cameraVector = new THREE.Vector3();
        this.camera.layers.enable(1);

        this.scene = new THREE.Scene();
        this.videoTexture = new THREE.VideoTexture(this.getVideoEl_());

        // shared regardless of wether VideoTexture is used or
        // an image canvas is used
        this.videoTexture.generateMipmaps = false;
        this.videoTexture.minFilter = THREE.LinearFilter;
        this.videoTexture.magFilter = THREE.LinearFilter;
        this.videoTexture.format = THREE.RGBFormat;

        const position = { x: 0, y: 0, z: 0 };

        if (this.scene) {
            this.scene.remove(this.movieScreen);
        }

        // 360 equirectangular projection
        this.movieGeometry = new THREE.SphereBufferGeometry(256, 32, 32);
        this.movieMaterial = new THREE.MeshBasicMaterial({ map: this.videoTexture, side: THREE.BackSide });

        this.movieScreen = new THREE.Mesh(this.movieGeometry, this.movieMaterial);
        this.movieScreen.position.set(position.x, position.y, position.z);

        this.movieScreen.scale.x = -1;
        this.movieScreen.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, -Math.PI / 2);
        this.scene.add(this.movieScreen);

        this.player.removeChild('BigPlayButton');
        this.player.addChild('BigVrPlayButton', {}, this.bigPlayButtonIndex_);
        this.player.bigPlayButton = this.player.getChild('BigVrPlayButton');

        this.camera.position.set(0, 0, 0);
        this.renderer = new THREE.WebGLRenderer({
            alpha: false,
            clearColor: 0xffffff,
            antialias: true
        });   

        this.renderer.setSize(this.player.currentWidth(), this.player.currentHeight());
        this.renderer.setPixelRatio( window.devicePixelRatio );

        this.renderedCanvas = this.renderer.domElement;
        this.renderedCanvas.setAttribute('style', 'width: 100%; height: 100%; position: absolute; top:0;');

        const videoElStyle = this.getVideoEl_().style;

        this.player.el().insertBefore(this.renderedCanvas, this.player.el().firstChild);
        videoElStyle.zIndex = '-1';
        videoElStyle.opacity = '0';
        this.xrActive = false;

        if (!this.controls3d) {
            // self.controls3d = new OrbitControls(self.camera, self.renderedCanvas);
            const options = {
                camera: this.camera,
                canvas: this.renderedCanvas,
                // check if its a half sphere view projection
                halfView: false,
                orientation: false
            };

            this.controls3d = new OrbitOrientationControls(options);
            this.canvasPlayerControls = new CanvasPlayerControls(this.player, this.renderedCanvas);
        }

        if (window.navigator.xr) {
            this.renderer.xr.enabled = true;
            // this.renderer.xr.setReferenceSpaceType('local');
            var self = this;
            navigator.xr.isSessionSupported('immersive-vr').then(function (supported) {
                if (supported) {
                    self.xrSupported = true;
                    self.addCardboardButton_();
                    console.log('webxr session supported');
                } else {
                    console.log('web xr device not found, using orbit controls');
                }
            });
        } else {
            console.log('web xr not available');
        }

        self.completeInitialization(); // wait until controls are initialized

        this.animationFrameId_ = this.requestAnimationFrame(this.animate_);

        this.on(this.player, 'fullscreenchange', this.handleResize_);
        window.addEventListener('vrdisplaypresentchange', this.handleResize_, true);
        window.addEventListener('resize', this.handleResize_, true);
        window.addEventListener('vrdisplayactivate', this.handleVrDisplayActivate_, true);
        window.addEventListener('vrdisplaydeactivate', this.handleVrDisplayDeactivate_, true);

    }

    completeInitialization() {
        this.initialized_ = true;
        this.trigger('initialized');
    }

    addCardboardButton_() {
        if (!this.player.controlBar.getChild('CardboardButton')) {
            this.player.controlBar.addChild('CardboardButton', {});
        }
    }

    getVideoEl_() {
        return this.player.el().getElementsByTagName('video')[0];
    }

    reset() {
        if (!this.initialized_) {
            return;
        }

        if (this.controls3d) {
            this.controls3d.dispose();
            this.controls3d = null;
        }

        if (this.canvasPlayerControls) {
            this.canvasPlayerControls.dispose();
            this.canvasPlayerControls = null;
        }

        window.removeEventListener('resize', this.handleResize_, true);
        window.removeEventListener('vrdisplaypresentchange', this.handleResize_, true);
        window.removeEventListener('vrdisplayactivate', this.handleVrDisplayActivate_, true);
        window.removeEventListener('vrdisplaydeactivate', this.handleVrDisplayDeactivate_, true);

        // re-add the big play button to player
        if (!this.player.getChild('BigPlayButton')) {
            this.player.addChild('BigPlayButton', {}, this.bigPlayButtonIndex_);
        }

        if (this.player.getChild('BigVrPlayButton')) {
            this.player.removeChild('BigVrPlayButton');
        }

        // remove the cardboard button
        if (this.player.getChild('CardboardButton')) {
            this.player.controlBar.removeChild('CardboardButton');
        }

        // reset the video element style so that it will be displayed
        const videoElStyle = this.getVideoEl_().style;

        videoElStyle.zIndex = '';
        videoElStyle.opacity = '';

        // remove the old canvas
        if (this.renderedCanvas) {
            this.renderedCanvas.parentNode.removeChild(this.renderedCanvas);
        }

        if (this.animationFrameId_) {
            this.cancelAnimationFrame(this.animationFrameId_);
        }

        this.initialized_ = false;
    }

    dispose() {
        this.reset();
        super.dispose();
    }

    polyfillVersion() {
        return WebXRPolyfill.version;
    }

}

// Define default values for the plugin's `state` object here.
Xr.defaultState = {};

// Include the version number.
Xr.VERSION = VERSION;

// Register the plugin with video.js.
videojs.registerPlugin('xr', Xr);

export default Xr;
