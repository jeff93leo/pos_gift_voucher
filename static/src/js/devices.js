
function openerp_pos_gift_voucher_devices(instance,module){ //module is instance.pos_gift_voucher
	var _t = instance.web._t;



    // this module interfaces with the barcode reader. It assumes the barcode reader
    // is set-up to act like  a keyboard. Use connect() and disconnect() to activate
    // and deactivate the barcode reader. Use set_action_callbacks to tell it
    // what to do when it reads a barcode.
    module.BarcodeReader =  module.BarcodeReader.extend({
        actions:[
            'product',
            'cashier',
            'client',
            'coupon',
            'coupon1',
        ],

        init: function(attributes){
            this.pos = attributes.pos;
            this.action_callback = {};
            this.proxy = attributes.proxy;
            this.remote_scanning = false;
            this.remote_active = 0;

            this.action_callback_stack = [];

            this.add_barcode_patterns(attributes.patterns || {
                'product':  ['xxxxxxxxxxxxx'],
                'cashier':  ['041xxxxxxxxxx'],
                'client':   ['042xxxxxxxxxx'],
                'weight':   ['21xxxxxNNDDDx'],
                'discount': ['22xxxxxxxxNNx'],
                'price':    ['23xxxxxNNNDDx'],
                'coupon':  	['xxxxxxxxxxxxxx'],
                'coupon1':  ['xxxxxxxxxxxxxxx'],
            });

        },

        add_barcode_patterns: function(patterns){
            this.patterns = this.patterns || {};
            for(type in patterns){
                this.patterns[type] = this.patterns[type] || [];

                var patternlist = patterns[type];
                if( typeof patternlist === 'string'){
                    patternlist = patternlist.split(',');
                }
                for(var i = 0; i < patternlist.length; i++){
                    var pattern = patternlist[i].trim().substring(0,12);
                    if(!pattern.length){
                        continue;
                    }
                    pattern = pattern.replace(/[x\*]/gi,'x');
                    while(pattern.length < 12){
                        pattern += 'x';
                    }
                    this.patterns[type].push(pattern);
                }
            }

            this.sorted_patterns = [];
            for (var type in this.patterns){
                var patterns = this.patterns[type];
                for(var i = 0; i < patterns.length; i++){
                    var pattern = patterns[i];
                    var score = 0;
                    for(var j = 0; j < pattern.length; j++){
                        if(pattern[j] != 'x'){
                            score++;
                        }
                    }
                    this.sorted_patterns.push({type:type, pattern:pattern,score:score});
                }
            }
            this.sorted_patterns.sort(function(a,b){
                return b.score - a.score;
            });

        },

        save_callbacks: function(){
            var callbacks = {};
            for(name in this.action_callback){
                callbacks[name] = this.action_callback[name];
            }
            this.action_callback_stack.push(callbacks);
        },

        restore_callbacks: function(){
            if(this.action_callback_stack.length){
                var callbacks = this.action_callback_stack.pop();
                this.action_callback = callbacks;
            }
        },

        // when an ean is scanned and parsed, the callback corresponding
        // to its type is called with the parsed_ean as a parameter.
        // (parsed_ean is the result of parse_ean(ean))
        //
        // callbacks is a Map of 'actions' : callback(parsed_ean)
        // that sets the callback for each action. if a callback for the
        // specified action already exists, it is replaced.
        //
        // possible actions include :
        // 'product' | 'cashier' | 'client' | 'discount'

        set_action_callback: function(action, callback){
            if(arguments.length == 2){
                this.action_callback[action] = callback;
            }else{
                var actions = arguments[0];
                for(action in actions){
                    this.set_action_callback(action,actions[action]);
                }
            }
        },

        //remove all action callbacks
        reset_action_callbacks: function(){
            for(action in this.action_callback){
                this.action_callback[action] = undefined;
            }
        },
        // returns the checksum of the ean, or -1 if the ean has not the correct length, ean must be a string
        ean_checksum: function(ean){
            var code = ean.split('');
            if(code.length !== 13){
                return -1;
            }
            var oddsum = 0, evensum = 0, total = 0;
            code = code.reverse().splice(1);
            for(var i = 0; i < code.length; i++){
                if(i % 2 == 0){
                    oddsum += Number(code[i]);
                }else{
                    evensum += Number(code[i]);
                }
            }
            total = oddsum * 3 + evensum;
            return Number((10 - total % 10) % 10);
        },
        // returns true if the ean is a valid EAN codebar number by checking the control digit.
        // ean must be a string
        check_ean: function(ean){
            return ean.length == 13;
            return /^\d+$/.test(ean) && this.ean_checksum(ean) === Number(ean[ean.length-1]);
        },
        // returns a valid zero padded ean13 from an ean prefix. the ean prefix must be a string.
        sanitize_ean:function(ean){
            ean = ean.substr(0,13);

            for(var n = 0, count = (13 - ean.length); n < count; n++){
                ean = ean + '0';
            }
            return ean.substr(0,12) + this.ean_checksum(ean);
        },

        // attempts to interpret an ean (string encoding an ean)
        // it will check its validity then return an object containing various
        // information about the ean.
        // most importantly :
        // - code    : the ean
        // - type   : the type of the ean:
        //      'price' |  'weight' | 'product' | 'cashier' | 'client' | 'discount' | 'error'
        //
        // - value  : if the id encodes a numerical value, it will be put there
        // - base_code : the ean code with all the encoding parts set to zero; the one put on
        //               the product in the backend

        parse_ean: function(ean){
            var self = this;
            var parse_result = {
                encoding: 'ean13',
                type:'error',
                code:ean,
                base_code: ean,
                value: 0,
            };

            if (!this.check_ean(ean)){
            	if (ean.length == 14){
            		parse_result = {
                            encoding: 'code128',
                            type:'coupon',
                            code:ean,
                            base_code: ean,
                            value: 0,
                        };
            	}
            	if (ean.length == 15 ){
            		parse_result = {
                            encoding: 'code128',
                            type:'coupon1',
                            code:ean,
                            base_code: ean,
                            value: 0,
                        };
            	}
                return parse_result;
            }

            function is_number(char){
                n = char.charCodeAt(0);
                return n >= 48 && n <= 57;
            }

            function match_pattern(ean,pattern){
                for(var i = 0; i < pattern.length; i++){
                    var p = pattern[i];
                    var e = ean[i];
                    if( is_number(p) && p !== e ){
                        return false;
                    }
                }
                return true;
            }

            function get_value(ean,pattern){
                var value = 0;
                var decimals = 0;
                for(var i = 0; i < pattern.length; i++){
                    var p = pattern[i];
                    var v = parseInt(ean[i]);
                    if( p === 'N'){
                        value *= 10;
                        value += v;
                    }else if( p === 'D'){
                        decimals += 1;
                        value += v * Math.pow(10,-decimals);
                    }
                }
                return value;
            }

            function get_basecode(ean,pattern){
                var base = '';
                for(var i = 0; i < pattern.length; i++){
                    var p = pattern[i];
                    var v = ean[i];
                    if( p === 'x'  || is_number(p)){
                        base += v;
                    }else{
                        base += '0';
                    }
                }
                return self.sanitize_ean(base);
            }

            var patterns = this.sorted_patterns;

            for(var i = 0; i < patterns.length; i++){
                if(match_pattern(ean,patterns[i].pattern)){
                    parse_result.type  = patterns[i].type;
                    parse_result.value = get_value(ean,patterns[i].pattern);
                    // parse_result.base_code = get_basecode(ean,patterns[i].pattern);
                    parse_result.base_code = ean;
                    return parse_result;
                }
            }

            return parse_result;
        },

        scan: function(code){
            if(code.length < 3){
                return;
            }else if(code.length === 13 && this.check_ean(code)){
                var parse_result = this.parse_ean(code);
            }else if(code.length === 12 && this.check_ean('0'+code)){
                // many barcode scanners strip the leading zero of ean13 barcodes.
                // This is because ean-13 are UCP-A with an additional zero at the beginning,
                // so by stripping zeros you get retrocompatibility with UCP-A systems.
                var parse_result = this.parse_ean('0'+code);
            }else if(this.pos.db.get_product_by_reference(code)){
                var parse_result = {
                    encoding: 'reference',
                    type: 'product',
                    code: code,
                };
            }else if(code.length === 14){
                var parse_result = this.parse_ean(code);
            }else if(code.length === 15){
                var parse_result = this.parse_ean(code);
            }else{
                var parse_result = {
                    encoding: 'error',
                    type: 'error',
                    code: code,
                };
            }

            if(parse_result.type in {'product':'', 'weight':'', 'coupon':'', 'coupon1':''}){    //ean is associated to a product
                if(this.action_callback['product']){
                    this.action_callback['product'](parse_result);
                }

            }else{
                if(this.action_callback[parse_result.type]){
                    this.action_callback[parse_result.type](parse_result);
                }
            }
        },

        // starts catching keyboard events and tries to interpret codebar
        // calling the callbacks when needed.
        connect: function(){
            var self = this;
            var code = "";
            var timeStamp  = 0;
            var onlynumbers = true;
            var timeout = null;

            this.handler = function(e){
                if(e.which === 13){ //ignore returns
                    e.preventDefault();
                    return;
                }
                if(timeStamp + 50 < new Date().getTime()){
                    code = "";
                    onlynumbers = true;
                }

                timeStamp = new Date().getTime();
                clearTimeout(timeout);

                if( e.which < 48 || e.which >= 58 ){ // not a number
                    onlynumbers = false;
                }

                code += String.fromCharCode(e.which);

                // we wait for a while after the last input to be sure that we are not mistakingly
                // returning a code which is a prefix of a bigger one :
                // Internal Ref 5449 vs EAN13 5449000...

                timeout = setTimeout(function(){
                    self.scan(code);
                    code = "";
                    onlynumbers = true;
                },100);
            };

            $('body').on('keypress', this.handler);
        },

        // stops catching keyboard events
        disconnect: function(){
            $('body').off('keypress', this.handler)
        },

        // the barcode scanner will listen on the hw_proxy/scanner interface for
        // scan events until disconnect_from_proxy is called
        connect_to_proxy: function(){
            var self = this;
            this.remote_scanning = true;
            if(this.remote_active >= 1){
                return;
            }
            this.remote_active = 1;

            function waitforbarcode(){
                return self.proxy.connection.rpc('/hw_proxy/scanner',{},{timeout:7500})
                    .then(function(barcode){
                        if(!self.remote_scanning){
                            self.remote_active = 0;
                            return;
                        }
                        self.scan(barcode);
                        waitforbarcode();
                    },
                    function(){
                        if(!self.remote_scanning){
                            self.remote_active = 0;
                            return;
                        }
                        setTimeout(waitforbarcode,5000);
                    });
            }
            waitforbarcode();
        },

        // the barcode scanner will stop listening on the hw_proxy/scanner remote interface
        disconnect_from_proxy: function(){
            this.remote_scanning = false;
        },
    });

}
