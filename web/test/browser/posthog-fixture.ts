// CI-only transport double: exercise the real analyticsCore before_send/config
// at the initial page load without sending synthetic test data to PostHog.
let config:any;
const ph:any={
  persistence:{props:{}},
  init(key:string,options:any){
    config=options;(window as any).__analyticsConfig=options;(window as any).__analytics=[];
    options.loaded?.(ph);
    ph.capture('$pageview',{$current_url:location.href,$referrer:document.referrer,
      nested:{urls:[location.href]},token:key});
  },
  capture(event:string,props:any={}){
    const payload=config?.before_send({event,properties:{$current_url:location.href,...props}});
    if(payload)(window as any).__analytics?.push(payload);
  },
  register(props:any){Object.assign(ph.persistence.props,props);},
  unregister(key:string){delete ph.persistence.props[key];},
  get_distinct_id(){return 'synthetic-anonymous';},
  stopSessionRecording(){(window as any).__replayStopped=true;},
  identify(){},reset(){},captureException(){},
};
export default ph;
