import * as THREE from 'three';
import { Vector2 } from 'three';
import { clamp } from 'three/src/math/MathUtils';
import { CubeInteraction } from './interaction';
import { CubeClientContext } from './client';

const STATE = {
  NONE: - 1,
  ROTATE: 0,
  DOLLY: 1,
  PAN: 2,
  TOUCH_ROTATE: 3,
  TOUCH_DOLLY: 4,
  TOUCH_PAN: 5
};

const CHANGE_EVENT = { type: 'change' };
const START_EVENT = { type: 'start' };
const END_EVENT = { type: 'end' };
const EPS = 0.000001;

/**
* @author qiao / https://github.com/qiao
* @author mrdoob / http://mrdoob.com
* @author alteredq / http://alteredqualia.com/
* @author WestLangley / http://github.com/WestLangley
* @author erich666 / http://erichaines.com
* @author nicolaspanel / http://github.com/nicolaspanel
*
* This set of controls performs orbiting, dollying (zooming), and panning.
* Unlike TrackballControls, it maintains the "up" direction object.up (+Y by default).
*    Orbit - left mouse / touch: one finger move
*    Zoom - middle mouse, or mousewheel / touch: two finger spread or squish
*    Pan - right mouse, or arrow keys / touch: three finger swipe
*/
export class OrbitControls extends THREE.EventDispatcher {
  object: THREE.Camera;
  domElement: HTMLElement | HTMLDocument;
  window: Window;

  // API
  enabled: boolean;
  target: THREE.Vector3;

  cubeInteraction: CubeInteraction;

  enableZoom: boolean;
  zoomSpeed: number;
  minDistance: () => number;
  maxDistance: number;
  enableRotate: boolean;
  rotateSpeed: number;
  enablePan: boolean;
  keyPanSpeed: number;
  autoRotate: boolean;
  autoRotateSpeed: number;
  minZoom: number;
  maxZoom: () => number;
  minPolarAngle: number;
  maxPolarAngle: number;
  minAzimuthAngle: number;
  maxAzimuthAngle: number;
  enableKeys: boolean;
  keys: { LEFT: number; UP: number; RIGHT: number; BOTTOM: number; };
  mouseButtons: { ORBIT: THREE.MOUSE; ZOOM: THREE.MOUSE; PAN: THREE.MOUSE; };
  enableDamping: boolean;
  dampingFactor: number;

  private spherical: THREE.Spherical;
  private sphericalDelta: THREE.Spherical;
  private scale: number;
  private target0: THREE.Vector3;
  private position0: THREE.Vector3;
  private zoom0: any;
  private state: number;
  private panOffset: THREE.Vector3;
  private zoomChanged: boolean;

  private rotateStart: THREE.Vector2;
  private rotateEnd: THREE.Vector2;
  private rotateDelta: THREE.Vector2

  private panStart: THREE.Vector2;
  private panEnd: THREE.Vector2;
  private panDelta: THREE.Vector2;

  private dollyStart: THREE.Vector2;
  private dollyEnd: THREE.Vector2;
  private dollyDelta: THREE.Vector2;

  private lastZoomDistance: number;

  private updateLastPosition: THREE.Vector3;
  private updateOffset: THREE.Vector3;
  private updateQuat: THREE.Quaternion;
  private updateLastQuaternion: THREE.Quaternion;
  private updateQuatInverse: THREE.Quaternion;

  private panLeftV: THREE.Vector3;
  private panUpV: THREE.Vector3;
  private panInternalOffset: THREE.Vector3;

  private onContextMenu: EventListener;
  onMouseUp: EventListener;
  onMouseDown: EventListener;
  onMouseMove: EventListener;
  onMouseWheel: EventListener;
  onTouchStart: EventListener;
  onTouchEnd: EventListener;
  onTouchMove: EventListener;
  onKeyDown: EventListener;

  constructor (context: CubeClientContext, object: THREE.Camera, domElement: HTMLElement, domWindow?: Window) {
    super();
    this.cubeInteraction = context.interaction;
    this.object = object;

    this.domElement = ( domElement !== undefined ) ? domElement : document;
    this.window = ( domWindow !== undefined ) ? domWindow : window;

    this.lastZoomDistance = 0;

    // Set to false to disable this control
    this.enabled = true;

    // "target" sets the location of focus, where the object orbits around
    this.target = new THREE.Vector3();

    // How far you can dolly in and out ( PerspectiveCamera only )
    this.minDistance = () => context.isClientPortrait() ? 4.0 - (4 * (context.screenAspectRatio - 0.5)) : 2;
    this.maxDistance = 15;

    // How far you can zoom in and out ( OrthographicCamera only )
    this.minZoom = 0.3;
    this.maxZoom = () => context.isClientPortrait() ? 1.4 + (3 * (context.screenAspectRatio - 0.5)) : 3.0;

    // How far you can orbit vertically, upper and lower limits.
    // Range is 0 to Math.PI radians.
    this.minPolarAngle = 0; // radians
    this.maxPolarAngle = Math.PI; // radians

    // How far you can orbit horizontally, upper and lower limits.
    // If set, must be a sub-interval of the interval [ - Math.PI, Math.PI ].
    this.minAzimuthAngle = - Infinity; // radians
    this.maxAzimuthAngle = Infinity; // radians

    // Set to true to enable damping (inertia)
    // If damping is enabled, you must call controls.update() in your animation loop
    this.enableDamping = false;
    this.dampingFactor = 0.25;

    // This option actually enables dollying in and out; left as "zoom" for backwards compatibility.
    // Set to false to disable zooming
    this.enableZoom = true;
    this.zoomSpeed = 0.6;

    // Set to false to disable rotating
    this.enableRotate = true;
    this.rotateSpeed = 1.0;

    // Set to false to disable panning
    this.enablePan = true;
    this.keyPanSpeed = 7.0;	// pixels moved per arrow key push

    // Set to true to automatically rotate around the target
    // If auto-rotate is enabled, you must call controls.update() in your animation loop
    this.autoRotate = false;
    this.autoRotateSpeed = 2.0; // 30 seconds per round when fps is 60

    // Set to false to disable use of the keys
    this.enableKeys = true;

    // The four arrow keys
    this.keys = { LEFT: 37, UP: 38, RIGHT: 39, BOTTOM: 40 };

    // Mouse buttons
    this.mouseButtons = { ORBIT: THREE.MOUSE.LEFT, ZOOM: THREE.MOUSE.MIDDLE, PAN: THREE.MOUSE.RIGHT };

    // for reset
    this.target0 = this.target.clone();
    this.position0 = this.object.position.clone();
    this.zoom0 = (this.object as any).zoom;

    // for update speedup
    this.updateOffset = new THREE.Vector3();
    // so camera.up is the orbit axis
    this.updateQuat = new THREE.Quaternion().setFromUnitVectors( object.up, new THREE.Vector3( 0, 1, 0 ) );
    this.updateQuatInverse = this.updateQuat.clone().invert();
    this.updateLastPosition = new THREE.Vector3();
    this.updateLastQuaternion = new THREE.Quaternion();

    this.state = STATE.NONE;
    this.scale = 1;

    // current position in spherical coordinates
    this.spherical = new THREE.Spherical();
    this.sphericalDelta = new THREE.Spherical();

    this.panOffset = new THREE.Vector3();
    this.zoomChanged = false;

    this.rotateStart = new THREE.Vector2();
    this.rotateEnd = new THREE.Vector2();
    this.rotateDelta = new THREE.Vector2();

    this.panStart = new THREE.Vector2();
    this.panEnd = new THREE.Vector2();
    this.panDelta = new THREE.Vector2();

    this.dollyStart = new THREE.Vector2();
    this.dollyEnd = new THREE.Vector2();
    this.dollyDelta = new THREE.Vector2();

    this.panLeftV = new THREE.Vector3();
    this.panUpV = new THREE.Vector3();
    this.panInternalOffset = new THREE.Vector3();

    // event handlers - FSM: listen for events and reset state

    this.onMouseDown = ( event: any ) => {
      if ( this.enabled === false ) return;
      event.preventDefault();
      if (event.actOnWorld) {
        if ( (event as any).button === this.mouseButtons.ORBIT ) {
          if ( this.enableRotate === false ) return;
          this.rotateStart.set( event.clientX, event.clientY );
          this.state = STATE.ROTATE;
        } else if ( event.button === this.mouseButtons.ZOOM ) {
          if ( this.enableZoom === false ) return;
          this.dollyStart.set( event.clientX, event.clientY );
          this.state = STATE.DOLLY;
        } else if ( event.button === this.mouseButtons.PAN ) {
          if ( this.enablePan === false ) return;
          this.panStart.set( event.clientX, event.clientY );
          this.state = STATE.PAN;
        }
      }

      if ( this.state !== STATE.NONE ) {
        this.dispatchEvent( START_EVENT );
      }
    };

    this.onMouseMove = ( event: any ) => {

      if ( this.enabled === false ) return;

      event.preventDefault();

      if ( this.state === STATE.ROTATE ) {
        if ( this.enableRotate === false ) return;
        this.rotateEnd.set( event.clientX, event.clientY );
        this.rotateDelta.subVectors( this.rotateEnd, this.rotateStart );
        const element = this.domElement === document ? this.domElement.body : this.domElement;

        // rotating across whole screen goes 360 degrees around
        this.rotateLeft( 2 * Math.PI * this.rotateDelta.x / (element as any).clientWidth * this.rotateSpeed );
        // rotating up and down along whole screen attempts to go 360, but limited to 180
        this.rotateUp( 2 * Math.PI * this.rotateDelta.y / (element as any).clientHeight * this.rotateSpeed );
        this.rotateStart.copy( this.rotateEnd );

        this.update();
      } else if ( this.state === STATE.DOLLY ) {

        if ( this.enableZoom === false ) return;

        this.dollyEnd.set( event.clientX, event.clientY );
        this.dollyDelta.subVectors( this.dollyEnd, this.dollyStart );

        if ( this.dollyDelta.y > 0 ) {
          this.dollyIn( this.getZoomScale() );
        } else if ( this.dollyDelta.y < 0 ) {
          this.dollyOut( this.getZoomScale() );
        }

        this.dollyStart.copy( this.dollyEnd );
        this.update();
      } else if ( this.state === STATE.PAN ) {

        if ( this.enablePan === false ) return;

        this.panEnd.set( event.clientX, event.clientY );
        this.panDelta.subVectors( this.panEnd, this.panStart );
        this.pan( this.panDelta.x, this.panDelta.y );
        this.panStart.copy( this.panEnd );
        this.update();
      }
    }

    this.onMouseUp = ( event: any ) => {
      if ( this.enabled === false ) return;

      this.dispatchEvent( END_EVENT );
      this.state = STATE.NONE;
    };

    this.onMouseWheel = ( event: any ) => {

      if ( this.enabled === false || this.enableZoom === false || ( this.state !== STATE.NONE && this.state !== STATE.ROTATE ) ) return;

      event.preventDefault();
      event.stopPropagation();

      if ( event.deltaY < 0 ) {
        this.dollyOut( this.getZoomScale() );
      } else if ( event.deltaY > 0 ) {
        this.dollyIn( this.getZoomScale() );
      }

      this.update();

      this.dispatchEvent( START_EVENT ); // not sure why these are here...
      this.dispatchEvent( END_EVENT );
    };

    this.onKeyDown = ( event: any ) => {

      if ( this.enabled === false || this.enableKeys === false || this.enablePan === false ) return;

      switch ( event.keyCode ) {
        case this.keys.UP: {
          this.pan( 0, this.keyPanSpeed );
          this.update();
        } break;
        case this.keys.BOTTOM: {
          this.pan( 0, - this.keyPanSpeed );
          this.update();
        } break;
        case this.keys.LEFT: {
          this.pan( this.keyPanSpeed, 0 );
          this.update();
        } break;
        case this.keys.RIGHT: {
          this.pan( - this.keyPanSpeed, 0 );
          this.update();
        } break;
      }
    };

    this.onTouchStart = ( event: any ) => {
      event.preventDefault();
      event.stopPropagation();

      if ( this.enabled === false ) return;

      switch ( event.touches.length ) {
        	// one-fingered touch: rotate
        case 1: {
          if ( this.enableRotate === false ) return;

          this.rotateStart.set( event.touches[ 0 ].pageX, event.touches[ 0 ].pageY );
          if (!event.actOnWorld) {
            this.cubeInteraction.onPanStart(new Vector2(event.touches[ 0 ].clientX, event.touches[ 0 ].clientY))
          }
          this.state = STATE.TOUCH_ROTATE;
        } break;
        // two-fingered touch: dolly
        case 2:	{
          if ( this.enableZoom === false ) return;

          var dx = event.touches[ 0 ].pageX - event.touches[ 1 ].pageX;
          var dy = event.touches[ 0 ].pageY - event.touches[ 1 ].pageY;

          var distance = Math.sqrt( dx * dx + dy * dy );
          this.dollyStart.set( 0, distance );
          this.state = STATE.TOUCH_DOLLY;
        } break;
        // three-fingered touch: pan
        case 3: {
          if ( this.enablePan === false ) return;

          this.panStart.set( event.touches[ 0 ].pageX, event.touches[ 0 ].pageY );
          this.state = STATE.TOUCH_PAN;
        } break;
        default: {
          this.state = STATE.NONE;
        }
      }

      if ( this.state !== STATE.NONE ) {
        this.dispatchEvent( START_EVENT );
      }
    };

    this.onTouchMove = ( event: any ) => {
      event.preventDefault();
      event.stopPropagation();

      if ( this.enabled === false ) return;

      switch ( event.touches.length ) {
        // one-fingered touch: rotate
        case 1: {
          if ( this.enableRotate === false ) return;
          if ( this.state !== STATE.TOUCH_ROTATE ) return; // is this needed?...

          this.rotateEnd.set( event.touches[ 0 ].pageX, event.touches[ 0 ].pageY );
          this.rotateDelta.subVectors( this.rotateEnd, this.rotateStart );

          if (event.actOnWorld) {
            var element = this.domElement === document ? this.domElement.body : this.domElement;
  
            // rotating across whole screen goes 360 degrees around
            this.rotateLeft( 2 * Math.PI * this.rotateDelta.x / (element as any).clientWidth * this.rotateSpeed );
  
            // rotating up and down along whole screen attempts to go 360, but limited to 180
            this.rotateUp( 2 * Math.PI * this.rotateDelta.y / (element as any).clientHeight * this.rotateSpeed );
          } else {
            this.cubeInteraction.onPanMove(new Vector2(event.touches[0].clientX, event.touches[0].clientY));
          }

          this.rotateStart.copy( this.rotateEnd );

          this.update();
        } break;
        // two-fingered touch: dolly
        case 2: {
          if ( this.enableZoom === false ) return;
          if ( this.state !== STATE.TOUCH_DOLLY ) return; // is this needed?...

          //console.log( 'handleTouchMoveDolly' );
          var dx = event.touches[ 0 ].pageX - event.touches[ 1 ].pageX;
          var dy = event.touches[ 0 ].pageY - event.touches[ 1 ].pageY;

          var distance = Math.sqrt( dx * dx + dy * dy );
          
          if (this.lastZoomDistance == 0) {
            this.lastZoomDistance = distance;
          }
          if (event.actOnWorld) {            
            this.dollyEnd.set( 0, distance );
  
            this.dollyDelta.subVectors( this.dollyEnd, this.dollyStart );
            const zoomSpeed = clamp(Math.abs(this.dollyDelta.y / 10), 0, 2);
            if ( this.dollyDelta.y > 0 ) {
              this.dollyOut( this.getZoomScale(zoomSpeed) );
            } else if ( this.dollyDelta.y < 0 ) {
              this.dollyIn( this.getZoomScale(zoomSpeed) );
            }
            this.dollyStart.copy( this.dollyEnd );
            this.update();
          } else {
            this.cubeInteraction.onZoom(event.touches, distance - this.lastZoomDistance);
          }
          this.lastZoomDistance = distance;
        } break;
        // three-fingered touch: pan
        case 3: {
          if ( this.enablePan === false ) return;
          if ( this.state !== STATE.TOUCH_PAN ) return; // is this needed?...
          this.panEnd.set( event.touches[ 0 ].pageX, event.touches[ 0 ].pageY );
          this.panDelta.subVectors( this.panEnd, this.panStart );
          this.pan( this.panDelta.x, this.panDelta.y );
          this.panStart.copy( this.panEnd );
          this.update();
        } break;
        default: {
          this.state = STATE.NONE;
        }
      }
    };

    this.onTouchEnd = ( event: Event ) => {
      event.preventDefault();
      event.stopPropagation();
      this.lastZoomDistance = 0;

      if ( this.enabled === false ) return;
      this.dispatchEvent( END_EVENT );
      this.state = STATE.NONE;
    }

    this.onContextMenu = (event: Event) => {
      event.preventDefault();
    };
    
    this.domElement.addEventListener( 'contextmenu', this.onContextMenu, false );


    // force an update at start
    this.update();
  }

  update () {
    const position = this.object.position;
    this.updateOffset.copy( position ).sub( this.target );

    // rotate offset to "y-axis-is-up" space
    this.updateOffset.applyQuaternion( this.updateQuat );

    // angle from z-axis around y-axis
    this.spherical.setFromVector3( this.updateOffset );

    if ( this.autoRotate && this.state === STATE.NONE ) {
      this.rotateLeft( this.getAutoRotationAngle() );
    }

    (this.spherical as any).theta += (this.sphericalDelta as any).theta;
    (this.spherical as any).phi += (this.sphericalDelta as any).phi;

    // restrict theta to be between desired limits
    (this.spherical as (any) as any).theta = Math.max( this.minAzimuthAngle, Math.min( this.maxAzimuthAngle, (this.spherical as any).theta ) );

    // restrict phi to be between desired limits
    (this.spherical as any).phi = Math.max( this.minPolarAngle, Math.min( this.maxPolarAngle, (this.spherical as any).phi ) );

    this.spherical.makeSafe();

    (this.spherical as any).radius *= this.scale;

    // restrict radius to be between desired limits
    (this.spherical as any).radius = Math.max( this.minDistance(), Math.min( this.maxDistance, (this.spherical as any).radius ) );

    // move target to panned location
    this.target.add( this.panOffset );

    this.updateOffset.setFromSpherical( this.spherical );

    // rotate offset back to "camera-up-vector-is-up" space
    this.updateOffset.applyQuaternion( this.updateQuatInverse );

    position.copy( this.target ).add( this.updateOffset );

    this.object.lookAt( this.target );

    if ( this.enableDamping === true ) {

      (this.sphericalDelta as any).theta *= ( 1 - this.dampingFactor );
      (this.sphericalDelta as any).phi *= ( 1 - this.dampingFactor );

    } else {

      this.sphericalDelta.set( 0, 0, 0 );

    }

    this.scale = 1;
    this.panOffset.set( 0, 0, 0 );

    // update condition is:
    // min(camera displacement, camera rotation in radians)^2 > EPS
    // using small-angle approximation cos(x/2) = 1 - x^2 / 8

    if ( this.zoomChanged ||
      this.updateLastPosition.distanceToSquared( this.object.position ) > EPS ||
      8 * ( 1 - this.updateLastQuaternion.dot( this.object.quaternion ) ) > EPS ) {

      this.dispatchEvent( CHANGE_EVENT );
      this.updateLastPosition.copy( this.object.position );
      this.updateLastQuaternion.copy( this.object.quaternion );
      this.zoomChanged = false;
      return true;
    }
    return false;
  }

  panLeft( distance: number, objectMatrix: THREE.Matrix4 ) {
    this.panLeftV.setFromMatrixColumn( objectMatrix, 0 ); // get X column of objectMatrix
    this.panLeftV.multiplyScalar( - distance );
    this.panOffset.add( this.panLeftV );
  }

  panUp( distance: number, objectMatrix: THREE.Matrix4 ) {
    this.panUpV.setFromMatrixColumn( objectMatrix, 1 ); // get Y column of objectMatrix
    this.panUpV.multiplyScalar( distance );
    this.panOffset.add( this.panUpV );
  }

  // deltaX and deltaY are in pixels; right and down are positive
  pan( deltaX: number, deltaY: number ) {
    const element = this.domElement === document ? this.domElement.body : this.domElement;

    if (this._checkPerspectiveCamera(this.object)) {
      // perspective
      const position = this.object.position;
      this.panInternalOffset.copy( position ).sub( this.target );
      var targetDistance = this.panInternalOffset.length();

      // half of the fov is center to top of screen
      targetDistance *= Math.tan( ( this.object.fov / 2 ) * Math.PI / 180.0 );

      // we actually don't use screenWidth, since perspective camera is fixed to screen height
      this.panLeft( 2 * deltaX * targetDistance / (element as any).clientHeight, this.object.matrix );
      this.panUp( 2 * deltaY * targetDistance / (element as any).clientHeight, this.object.matrix );
    } else if (this._checkOrthographicCamera(this.object)) {
      // orthographic
      this.panLeft( deltaX * ( this.object.right - this.object.left ) / this.object.zoom / (element as any).clientWidth, this.object.matrix );
      this.panUp( deltaY * ( this.object.top - this.object.bottom ) / this.object.zoom / (element as any).clientHeight, this.object.matrix );
    } else {
      // camera neither orthographic nor perspective
      console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - pan disabled.' );
      this.enablePan = false;
    }
  }

  dollyIn( dollyScale: number ) {
    if (this._checkPerspectiveCamera(this.object)) {
      this.scale /= dollyScale;
    } else if (this._checkOrthographicCamera(this.object)) {
      this.object.zoom = Math.max( this.minZoom, Math.min( this.maxZoom(), this.object.zoom * dollyScale ) );
      this.object.updateProjectionMatrix();
      this.zoomChanged = true;
    } else {
      console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled.' );
      this.enableZoom = false;
    }
  }

  dollyOut( dollyScale: number ) {
    if (this._checkPerspectiveCamera(this.object)) {
      this.scale *= dollyScale;
    } else if (this._checkOrthographicCamera(this.object)) {
      this.object.zoom = Math.max( this.minZoom, Math.min( this.maxZoom(), this.object.zoom / dollyScale ) );
      this.object.updateProjectionMatrix();
      this.zoomChanged = true;
    } else {
      console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled.' );
      this.enableZoom = false;
    }
  }

  getAutoRotationAngle() {
    return 2 * Math.PI / 60 / 60 * this.autoRotateSpeed;
  }

  getZoomScale(zoomSpeed = this.zoomSpeed) {
    return Math.pow( 0.95, zoomSpeed );
  }

  rotateLeft( angle: number ) {
    (this.sphericalDelta as any).theta -= angle;
  }

  rotateUp( angle: number ) {
    (this.sphericalDelta as any).phi -= angle;
  }

  getPolarAngle (): number {
    return (this.spherical as any).phi;
  }

  getAzimuthalAngle (): number {
    return (this.spherical as any).theta;
  }

  dispose (): void {
    this.domElement.removeEventListener( 'contextmenu', this.onContextMenu, false );
    this.domElement.removeEventListener( 'mousedown', this.onMouseDown, false );
    this.domElement.removeEventListener( 'wheel', this.onMouseWheel, false );

    this.domElement.removeEventListener( 'touchstart', this.onTouchStart, false );
    this.domElement.removeEventListener( 'touchend', this.onTouchEnd, false );
    this.domElement.removeEventListener( 'touchmove', this.onTouchMove, false );

    document.removeEventListener( 'mousemove', this.onMouseMove, false );
    document.removeEventListener( 'mouseup', this.onMouseUp, false );

    this.window.removeEventListener( 'keydown', this.onKeyDown, false );
    //this.dispatchEvent( { type: 'dispose' } ); // should this be added here?
  }

  reset (): void {
    this.target.copy( this.target0 );
    this.object.position.copy( this.position0 );
    (this.object as any).zoom = this.zoom0;

    (this.object as any).updateProjectionMatrix();
    this.dispatchEvent( CHANGE_EVENT );

    this.update();

    this.state = STATE.NONE;
  }

  saveState(): void {
    this.target0.copy(this.target);
    this.position0.copy(this.object.position);
    // Check whether the camera has zoom property
    if (this._checkOrthographicCamera(this.object) || this._checkPerspectiveCamera(this.object)){
      this.zoom0 = this.object.zoom;
    }
  }

  // backward compatibility
  get center(): THREE.Vector3 {
    console.warn('THREE.OrbitControls: .center has been renamed to .target');
    return this.target;
  }
  get noZoom(): boolean {
    console.warn( 'THREE.OrbitControls: .noZoom has been deprecated. Use .enableZoom instead.' );
    return ! this.enableZoom;
  }

  set noZoom( value: boolean ) {
    console.warn( 'THREE.OrbitControls: .noZoom has been deprecated. Use .enableZoom instead.' );
    this.enableZoom = ! value;
  }

  /**
   * TS typeguard. Checks whether the provided camera is PerspectiveCamera. 
   * If the check passes (returns true) the passed camera will have the type THREE.PerspectiveCamera in the if branch where the check was performed.
   * @param camera Object to be checked.
   */
  private _checkPerspectiveCamera(camera: THREE.Camera): camera is THREE.PerspectiveCamera{
    return (camera as THREE.PerspectiveCamera).isPerspectiveCamera;
  }
  /**
   * TS typeguard. Checks whether the provided camera is OrthographicCamera. 
   * If the check passes (returns true) the passed camera will have the type THREE.OrthographicCamera in the if branch where the check was performed.
   * @param camera Object to be checked.
   */
  private _checkOrthographicCamera(camera: THREE.Camera): camera is THREE.OrthographicCamera{
    return (camera as THREE.OrthographicCamera).isOrthographicCamera;
  }
}

interface ThreeEvent extends Event {
  clientX: number;
  clientY: number;
  deltaY: number;
  button: THREE.MOUSE;
  touches: Array<any>;
  keyCode: number;
}